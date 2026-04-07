#!/usr/bin/env python3
"""
Build and launch the SFC Config Agent as an Amazon Bedrock AgentCore runtime.

This script is intentionally simple — there is exactly one agent in this repo:
  entrypoint : src/agent.py
  requirements: src/requirements.txt
  Dockerfile.deps: src/Dockerfile.deps  (optional system-level deps injected into the
                                          generated Dockerfile after the first FROM line)

After a successful deployment the AgentCore runtime ARN is written to the SSM
parameter /sfc-config-agent/agentcore-runtime-id so that the Control Plane
Lambda functions (fn-agent-create-config, fn-agent-remediate) can resolve it
at cold-start without hard-coding an ARN.

Usage (run from the repo root or from within the CodeBuild project):
  python scripts/build_launch_agentcore.py \
      --region <AWS_REGION> \
      --execution-role-arn <ROLE_ARN>
"""

import os
import json
import boto3
import logging
import argparse
from pathlib import Path

import yaml
from bedrock_agentcore_starter_toolkit.operations.runtime.configure import configure_bedrock_agentcore
from bedrock_agentcore_starter_toolkit.operations.runtime.launch import launch_bedrock_agentcore

# ── Constants ─────────────────────────────────────────────────────────────────
AGENT_ID       = "sfc_config_agent"
AGENT_NAME     = "SFC Config Agent"
AGENT_DIR      = "src"          # directory that contains agent.py
ENTRYPOINT     = "agent.py"     # relative to AGENT_DIR
REQUIREMENTS   = "requirements.txt"  # relative to AGENT_DIR
SSM_PARAM      = "/sfc-config-agent/agentcore-runtime-id"
OUTPUT_FILE    = "agentcore_deployment_results.json"

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("build_launch_agentcore")


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_account_id() -> str:
    return boto3.client("sts").get_caller_identity()["Account"]


def inject_dockerfile_deps(agent_dir: str, dockerfile_path: str) -> None:
    """
    Inject the contents of src/Dockerfile.deps into the generated Dockerfile
    immediately after the first FROM line (system-level apt/yum installs, etc.).
    No-op if src/Dockerfile.deps does not exist.
    """
    deps_file = os.path.join(agent_dir, "Dockerfile.deps")
    if not os.path.exists(deps_file):
        logger.info("No Dockerfile.deps found — skipping injection.")
        return

    with open(deps_file) as f:
        deps = f.read().strip()

    with open(dockerfile_path) as f:
        content = f.read()

    # Insert after the first blank line that follows the FROM statement
    content = content.replace("\n\n", f"\n\n{deps}\n\n", 1)

    with open(dockerfile_path, "w") as f:
        f.write(content)

    logger.info(f"Injected Dockerfile.deps into {dockerfile_path}")


def patch_platform(config_path: str) -> None:
    """Force linux/arm64 platform in the generated AgentCore config YAML."""
    with open(config_path, encoding="utf-8") as f:
        config_data = yaml.safe_load(f)

    for agent_name, agent_cfg in config_data.get("agents", {}).items():
        if "platform" in agent_cfg:
            logger.info(
                f"Changing platform from {agent_cfg['platform']} → linux/arm64 "
                f"for agent {agent_name}"
            )
            agent_cfg["platform"] = "linux/arm64"

    with open(config_path, "w", encoding="utf-8") as f:
        yaml.dump(config_data, f, default_flow_style=False)

    logger.info(f"Platform patched in {config_path}")


def deploy_agent(region: str, execution_role_arn: str) -> dict:
    """
    Configure, build, and launch the SFC Config Agent AgentCore runtime.
    Returns a dict with deployment info or an 'error' key on failure.
    """
    logger.info(f"Deploying {AGENT_NAME} from {AGENT_DIR}/{ENTRYPOINT}")

    original_dir = os.getcwd()
    try:
        os.chdir(AGENT_DIR)

        requirements_path = Path(REQUIREMENTS)
        requirements_file = str(requirements_path) if requirements_path.exists() else None
        logger.info(f"requirements_file={requirements_file}")

        # ── Configure (generates Dockerfile + .bedrock_agentcore.yaml) ──────
        config_result = configure_bedrock_agentcore(
            agent_name=AGENT_ID,
            entrypoint_path=Path(ENTRYPOINT),
            execution_role=execution_role_arn,
            auto_create_ecr=True,
            enable_observability=True,
            region=region,
            container_runtime="docker",
            verbose=True,
            requirements_file=requirements_file,
        )

        # ── Inject system deps & patch platform ──────────────────────────────
        inject_dockerfile_deps(
            os.path.join(original_dir, AGENT_DIR),
            str(config_result.dockerfile_path),
        )
        patch_platform(str(config_result.config_path))

        # ── Launch (build image, push to ECR, register runtime) ─────────────
        logger.info(f"Launching {AGENT_ID}")
        result = launch_bedrock_agentcore(
            config_result.config_path,
            local=False,
            auto_update_on_conflict=True,
        )

        deployment_info = {
            "agent_arn": result.agent_arn,
            "agent_id": result.agent_id,
            "ecr_uri": result.ecr_uri,
            "agent_name": AGENT_NAME,
        }
        logger.info(
            f"Successfully deployed {AGENT_NAME}: "
            f"agent_id={result.agent_id}, arn={result.agent_arn}"
        )
        return deployment_info

    except Exception as exc:
        import traceback
        logger.error(f"Deployment failed: {exc}")
        logger.error(traceback.format_exc())
        return {"error": str(exc), "agent_name": AGENT_NAME}

    finally:
        os.chdir(original_dir)


def update_ssm(agent_arn: str, region: str) -> None:
    """Write the deployed runtime ARN to the well-known SSM parameter."""
    ssm = boto3.client("ssm", region_name=region)
    ssm.put_parameter(
        Name=SSM_PARAM,
        Value=agent_arn,
        Type="String",
        Overwrite=True,
    )
    logger.info(f"Updated SSM parameter {SSM_PARAM} → {agent_arn}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Build and launch the SFC Config Agent")
    parser.add_argument("--region", required=True, help="AWS region")
    parser.add_argument(
        "--execution-role-arn", required=True, help="ARN of the AgentCore execution role"
    )
    args = parser.parse_args()

    result = deploy_agent(args.region, args.execution_role_arn)

    # Persist results for the CodeBuild post_build phase
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    logger.info(f"Deployment results saved to {OUTPUT_FILE}")

    if "error" in result:
        print(f"\n❌ {AGENT_NAME}: Failed — {result['error']}")
        raise SystemExit(1)

    # Update SSM so Lambda functions can resolve the runtime ARN at cold-start
    update_ssm(result["agent_arn"], args.region)

    print(f"\n✅ {AGENT_NAME}: Deployed")
    print(f"   Agent ID : {result['agent_id']}")
    print(f"   ARN      : {result['agent_arn']}")
    print(f"   ECR URI  : {result['ecr_uri']}")
    print(f"   SSM param: {SSM_PARAM}")


if __name__ == "__main__":
    main()
