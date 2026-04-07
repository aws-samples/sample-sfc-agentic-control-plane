import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { LaunchPackageTables } from './launch-package-tables';
import { ControlPlaneApi } from './control-plane-api';
import { SfcHeartbeatRule } from './heartbeat-rule';

export interface SfcConfigAgentInfraProps {
  agentRole?: iam.IRole;
  /** Bucket created in the root stack — keeps the OAC bucket policy and
   *  CloudFront distribution in the same stack, avoiding circular deps. */
  artifactsBucket: s3.Bucket;
}

/**
 * SfcConfigAgentInfra — plain Construct (not a NestedStack).
 * All resources land directly in the parent stack; no cross-stack token edges.
 */
export class SfcConfigAgentInfra extends Construct {
  public readonly artifactsBucket: s3.Bucket;
  public readonly filesTable: dynamodb.Table;
  public readonly memoryExecutionRole: iam.Role;
  public readonly cpTables: LaunchPackageTables;
  public readonly cpApi: ControlPlaneApi;
  public readonly heartbeatRule: SfcHeartbeatRule;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: SfcConfigAgentInfraProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    this.artifactsBucket = props.artifactsBucket;

    // ── DynamoDB: file metadata ───────────────────────────────────────
    this.filesTable = new dynamodb.Table(this, 'SfcAgentFilesTable', {
      tableName: 'SFC_Agent_Files',
      partitionKey: { name: 'file_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sort_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // ── AgentCore Memory execution role ───────────────────────────────
    this.memoryExecutionRole = new iam.Role(this, 'SfcAgentMemoryExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for SFC Config Agent AgentCore Memory consolidation',
    });

    this.memoryExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${region}::foundation-model/*`],
    }));

    this.memoryExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/*`],
    }));

    // ── AgentCore Memory — Lambda-backed custom resource ──────────────
    // AWS::BedrockAgentCore::Memory is not yet a native CloudFormation resource.
    const memoryHandlerCode = `
import json, boto3, urllib.request
SUCCESS = 'SUCCESS'
FAILED  = 'FAILED'

def send(event, context, status, data, physical_id, reason=''):
    body = json.dumps({
        'Status': status, 'Reason': reason,
        'PhysicalResourceId': physical_id,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data,
    }).encode()
    req = urllib.request.Request(event['ResponseURL'],
        data=body, method='PUT',
        headers={'Content-Type': '', 'Content-Length': len(body)})
    urllib.request.urlopen(req)

def find_existing_memory(client, name):
    paginator_kwargs = {}
    while True:
        resp = client.list_memories(**paginator_kwargs)
        for mem in resp.get('memories', []):
            mem_name = mem.get('name') or mem.get('memoryName', '')
            if mem_name == name:
                return mem.get('memoryId') or mem.get('id')
        next_token = resp.get('nextToken')
        if not next_token:
            break
        paginator_kwargs = {'nextToken': next_token}
    return None

def handler(event, context):
    props  = event.get('ResourceProperties', {})
    region = props.get('Region')
    req_type = event['RequestType']
    physical_id = event.get('PhysicalResourceId', 'pending')
    try:
        client = boto3.client('bedrock-agentcore-control', region_name=region)
        if req_type == 'Create':
            memory_id = find_existing_memory(client, props['MemoryName'])
            if not memory_id:
                resp = client.create_memory(
                    name=props['MemoryName'],
                    description=props['Description'],
                    memoryExecutionRoleArn=props['MemoryExecutionRoleArn'],
                    eventExpiryDuration=int(props.get('EventExpiryDuration', 90)),
                    memoryStrategies=[{
                        'semanticMemoryStrategy': {
                            'name': 'sfc_semantic_memory',
                            'description': 'Captures key SFC topology facts and protocol preferences from conversations.',
                        }
                    }],
                )
                mem = resp.get('memory', resp)
                memory_id = (mem.get('memoryId') or mem.get('id') or resp.get('memoryId'))
                if not memory_id:
                    raise KeyError('memoryId not found in response: ' + str(resp))
            send(event, context, SUCCESS, {'MemoryId': memory_id}, memory_id)
        elif req_type == 'Delete':
            send(event, context, SUCCESS, {}, physical_id)
        else:
            send(event, context, SUCCESS, {}, physical_id)
    except Exception as exc:
        send(event, context, FAILED, {}, physical_id, str(exc))
`;

    const memoryHandlerFn = new lambda.Function(this, 'SfcMemoryHandlerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(memoryHandlerCode),
      timeout: Duration.minutes(5),
    });

    memoryHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:CreateMemory', 'bedrock-agentcore:GetMemory', 'bedrock-agentcore:ListMemories'],
      resources: ['*'],
    }));

    memoryHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [this.memoryExecutionRole.roleArn],
    }));

    const memoryResource = new CustomResource(this, 'SfcAgentCoreMemory', {
      serviceToken: memoryHandlerFn.functionArn,
      removalPolicy: RemovalPolicy.RETAIN,
      properties: {
        Region: region,
        MemoryName: 'sfc_config_agent_memory',
        Description: 'Persistent memory store for the SFC Config Generation Agent.',
        MemoryExecutionRoleArn: this.memoryExecutionRole.roleArn,
        EventExpiryDuration: '90',
      },
    });

    memoryResource.node.addDependency(this.memoryExecutionRole);

    // ── Agent role: memory + SSM permissions ─────────────────────────
    if (props.agentRole) {
      props.agentRole.addToPrincipalPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetMemory',
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:GetSession',
          'bedrock-agentcore:CreateSession',
          'bedrock-agentcore:UpdateSession',
          'bedrock-agentcore:ListSessions',
          'bedrock-agentcore:DeleteSession',
        ],
        resources: [`arn:aws:bedrock-agentcore:${region}:${account}:memory/*`],
      }));
      props.agentRole.addToPrincipalPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${region}:${account}:parameter/sfc-config-agent/memory-id`],
      }));
    }

    // ── SSM Parameters ────────────────────────────────────────────────
    new ssm.StringParameter(this, 'SfcS3BucketNameParameter', {
      parameterName: '/sfc-config-agent/s3-bucket-name',
      stringValue: this.artifactsBucket.bucketName,
    });

    new ssm.StringParameter(this, 'SfcDdbTableNameParameter', {
      parameterName: '/sfc-config-agent/ddb-table-name',
      stringValue: this.filesTable.tableName,
    });

    new ssm.StringParameter(this, 'SfcMemoryIdParameter', {
      parameterName: '/sfc-config-agent/memory-id',
      stringValue: memoryResource.getAttString('MemoryId'),
    });

    // Placeholder — overwritten by build_launch_agentcore.py after deployment
    new ssm.StringParameter(this, 'SfcAgentCoreRuntimeIdParameter', {
      parameterName: '/sfc-config-agent/agentcore-runtime-id',
      stringValue: 'NOT_DEPLOYED_YET',
    });

    // ── WP-01: Control Plane tables ───────────────────────────────────
    this.cpTables = new LaunchPackageTables(this, 'ControlPlaneTables');

    // ── WP-03–12: Control Plane API ───────────────────────────────────
    this.cpApi = new ControlPlaneApi(this, 'ControlPlaneApi', {
      configsBucket: this.artifactsBucket,
      configTable: this.filesTable,
      launchPackageTable: this.cpTables.launchPackageTable,
      controlPlaneStateTable: this.cpTables.controlPlaneStateTable,
    });

    this.userPool = this.cpApi.userPool;
    this.userPoolClient = this.cpApi.userPoolClient;

    // ── WP-08b: IoT Heartbeat Rule ────────────────────────────────────
    this.heartbeatRule = new SfcHeartbeatRule(this, 'HeartbeatRule', {
      launchPackageTable: this.cpTables.launchPackageTable,
      layer: this.cpApi.layer,
    });

    // ── Outputs ───────────────────────────────────────────────────────
    new CfnOutput(this, 'SfcArtifactsBucketName', { value: this.artifactsBucket.bucketName });
    new CfnOutput(this, 'SfcFilesTableName', { value: this.filesTable.tableName });
    new CfnOutput(this, 'SfcMemoryId', { value: memoryResource.getAttString('MemoryId') });
    new CfnOutput(this, 'SfcMemoryExecutionRoleArn', { value: this.memoryExecutionRole.roleArn });
    new CfnOutput(this, 'SfcConfigBucketName', { value: this.artifactsBucket.bucketName });
    new CfnOutput(this, 'SfcLaunchPackageTableName', { value: this.cpTables.launchPackageTable.tableName });
    new CfnOutput(this, 'SfcControlPlaneStateTableName', { value: this.cpTables.controlPlaneStateTable.tableName });
  }
}
