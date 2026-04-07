import * as path from 'path';
import {
  CfnOutput,
  CustomResource,
  Duration,
  Fn,
  Stack,
  StackProps,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_codebuild as codebuild,
  aws_lambda as lambda,
  RemovalPolicy,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SfcConfigAgentInfra } from './constructs/sfc-config-agent-infra';
import { UiStack } from './ui-stack';

/**
 * SfcAgenticControlPlaneStack — root stack.
 *
 * CloudFront + UI CodeBuild live in UiStack (NestedStack).
 * Moving them out of the root template breaks the circular dependency:
 *
 *   httpApi (body→fn ARNs) → fn-authorizer (env→CpWebClient)
 *   → CpWebClient (callbackUrls=cfUrl) → UiDistribution (origin=httpApi.ref)
 *
 * In a NestedStack, httpApi.ref is passed as a plain CFN Parameter —
 * no inline token edge in the parent template, no cycle.
 */
export class SfcAgenticControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ── Source bucket (CodeBuild input) ───────────────────────────────
    const sourceBucket = new s3.Bucket(this, 'SfcSourceBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Artifacts bucket (UI dist + agent outputs) ────────────────────
    const artifactsBucket = new s3.Bucket(this, 'SfcAgentArtifactsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    // ── Agent execution role (AgentCore runtime + CodeBuild) ──────────
    const agentRole = new iam.Role(this, 'SfcAgentRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        new iam.ServicePrincipal('codebuild.amazonaws.com'),
      ),
      description: 'Execution role for the SFC Config Agent (AgentCore runtime + CodeBuild)',
    });

    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
      resources: [sourceBucket.bucketArn, `${sourceBucket.bucketArn}/*`],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
      resources: [artifactsBucket.bucketArn, `${artifactsBucket.bucketArn}/*`],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:PutLifecycleConfiguration', 's3:GetLifecycleConfiguration', 's3:CreateBucket',
        's3:HeadBucket', 's3:GetObject', 's3:PutObject', 's3:ListBucket',
      ],
      resources: [
        `arn:aws:s3:::bedrock-agentcore-codebuild-sources-${this.account}-${this.region}`,
        `arn:aws:s3:::bedrock-agentcore-codebuild-sources-${this.account}-${this.region}/*`,
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:PutResourcePolicy'],
      resources: ['*'],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage', 'ecr:CreateRepository', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload', 'ecr:PutImage', 'ecr:TagResource', 'ecr:DescribeRepositories',
      ],
      resources: ['*'],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:*', 'bedrock-agentcore:*'],
      resources: ['*'],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'iam:GetRole', 'iam:CreateRole', 'iam:DeleteRole', 'iam:AttachRolePolicy',
        'iam:DetachRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:TagRole',
        'iam:PassRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies',
        'iam:ListRoles', 'iam:CreateServiceLinkedRole',
      ],
      resources: ['*'],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'codebuild:CreateProject', 'codebuild:UpdateProject', 'codebuild:StartBuild',
        'codebuild:BatchGetBuilds', 'codebuild:ListProjects', 'codebuild:BatchGetProjects',
      ],
      resources: ['*'],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/sfc-config-agent/*`],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
        'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem',
        'dynamodb:DescribeTable',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/SFC_Agent_Files`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/SFC_Agent_Files/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/SfcAgenticControlPlane*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/SfcAgenticControlPlane*/*`,
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:GetServiceBearerToken', 'sts:GetCallerIdentity'],
      resources: ['*'],
    }));

    // ── AgentCore deployment CodeBuild project ────────────────────────
    const deploymentProject = new codebuild.Project(this, 'SfcAgentCoreDeploymentProject', {
      projectName: `${this.stackName}-agentcore-deploy`,
      role: agentRole,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
        environmentVariables: {
          EXECUTION_ROLE_ARN: { value: agentRole.roleArn },
          AWS_REGION:         { value: this.region },
          S3_BUCKET:          { value: sourceBucket.bucketName },
          PYTHONUNBUFFERED:   { value: '1' },
        },
      },
      source: codebuild.Source.s3({ bucket: sourceBucket, path: '' }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { python: 'latest' },
            commands: [
              'pip install --upgrade pip',
              'pip install bedrock-agentcore-starter-toolkit boto3==1.39.9 bedrock-agentcore pyyaml',
            ],
          },
          pre_build: {
            commands: [
              'if [ -f repo ]; then unzip -q repo -d . && echo Extracted repo; fi',
              'aws sts get-caller-identity',
            ],
          },
          build: {
            commands: [
              'python src/scripts/build_launch_agentcore.py --region $AWS_REGION --execution-role-arn $EXECUTION_ROLE_ARN',
            ],
          },
          post_build: { commands: ['cat agentcore_deployment_results.json || true'] },
        },
        artifacts: { files: ['agentcore_deployment_results.json'], 'discard-paths': false },
        cache: { paths: ['/root/.cache/pip/**/*'] },
      }),
      timeout: Duration.minutes(60),
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
    });

    // ── Upload repo sources to S3 (runs on every cdk deploy) ─────────
    // Exclude list mirrors .gitignore — only git-tracked files land in S3.
    // node_modules must be excluded to keep the asset zip well under Lambda's
    // 512 MB limit used by the BucketDeployment custom resource.
    const repoDeployment = new s3deploy.BucketDeployment(this, 'SfcSourceUpload', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..'), {
          exclude: [
            // version control
            '.git', '.git/**',
            // node dependencies — never upload; CodeBuild installs them at build-time
            'node_modules', 'node_modules/**',
            'src/ui/node_modules', 'src/ui/node_modules/**',
            // build / generated outputs
            'cdk.out', 'cdk.out/**',
            'src/ui/dist', 'src/ui/dist/**',
            // local dev files
            '.sfc', '.sfc/**',
            'sfc-repo', 'sfc-repo/**',
            'src/ui/.env.local',
            'src/ui/package-lock.json',
          ],
        }),
      ],
      destinationBucket: sourceBucket,
      retainOnDelete: false,
    });

    // ── Control-plane infrastructure (API GW, Cognito, DynamoDB, IoT) ─
    const infra = new SfcConfigAgentInfra(this, 'SfcConfigAgentInfra', {
      agentRole,
      artifactsBucket,
    });

    // ── UI NestedStack ────────────────────────────────────────────────
    // Isolating CloudFront in a NestedStack breaks the circular dependency.
    // httpApi.ref becomes a plain CFN Parameter in the nested template —
    // the parent template has no token edge from UiDistribution back to httpApi.
    //
    // The UI CodeBuild job inside UiStack is the "final step":
    //   pre_build  → reads CF domain from SSM → sets VITE_COGNITO_REDIRECT_URI
    //   build      → npm run build with all VITE_ vars baked into .env.production
    //   post_build → s3 sync + update-user-pool-client (callback/logout URLs)
    const cognitoDomain = Fn.sub(
      'https://sfc-cp-${Account}-${Region}.auth.${Region}.amazoncognito.com',
      { Account: this.account, Region: this.region },
    );

    const uiStack = new UiStack(this, 'UiStack', {
      artifactsBucket,
      sourceBucket,
      httpApi: infra.cpApi.httpApi,
      viteApiBaseUrl: Fn.sub('https://${ApiId}.execute-api.${Region}.amazonaws.com', {
        ApiId: infra.cpApi.httpApi.ref,
        Region: this.region,
      }),
      viteCognitoDomain:   cognitoDomain,
      viteCognitoClientId: infra.userPoolClient.userPoolClientId,
      userPoolId:          infra.userPool.userPoolId,
      userPoolArn:         infra.userPool.userPoolArn,
      userPoolClientId:    infra.userPoolClient.userPoolClientId,
      region:              this.region,
      account:             this.account,
    });
    // UiStack must deploy after sources exist in S3
    uiStack.node.addDependency(repoDeployment);

    // ── Trigger Lambda — fires CodeBuild CRs on deploy ────────────────
    const triggerFn = new lambda.Function(this, 'SfcDeploymentTriggerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: Duration.minutes(5),
      code: lambda.Code.fromInline(`
import boto3, json, urllib.request

def handler(event, context):
    print(json.dumps(event))
    if event['RequestType'] in ('Create', 'Update'):
        cb = boto3.client('codebuild')
        project = event['ResourceProperties']['ProjectName']
        try:
            resp = cb.start_build(projectName=project)
            build_id = resp['build']['id']
            send(event, context, 'SUCCESS', {'BuildId': build_id}, build_id)
        except Exception as e:
            send(event, context, 'SUCCESS', {'Error': str(e)}, 'trigger-failed')
    else:
        send(event, context, 'SUCCESS', {}, event.get('PhysicalResourceId', 'trigger'))

def send(event, context, status, data, physical_id):
    body = json.dumps({
        'Status': status, 'Reason': 'See CloudWatch', 'PhysicalResourceId': physical_id,
        'StackId': event['StackId'], 'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'], 'Data': data,
    }).encode()
    req = urllib.request.Request(event['ResponseURL'], data=body, method='PUT',
        headers={'Content-Type': '', 'Content-Length': len(body)})
    urllib.request.urlopen(req)
`),
    });

    triggerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild'],
      resources: [deploymentProject.projectArn],
    }));

    // AgentCore deployment trigger (after repo sources are in S3)
    const agentCoreTrigger = new CustomResource(this, 'SfcAgentCoreDeploymentTrigger', {
      serviceToken: triggerFn.functionArn,
      properties: { ProjectName: deploymentProject.projectName, DeployVersion: '1' },
    });
    agentCoreTrigger.node.addDependency(repoDeployment);

    // ── Outputs ───────────────────────────────────────────────────────
    new CfnOutput(this, 'SourceBucketName',           { value: sourceBucket.bucketName });
    new CfnOutput(this, 'AgentRoleArn',               { value: agentRole.roleArn });
    new CfnOutput(this, 'AgentCoreDeploymentProject', { value: deploymentProject.projectName });
    new CfnOutput(this, 'SfcControlPlaneUiUrl',       { value: uiStack.distributionUrl });
  }
}
