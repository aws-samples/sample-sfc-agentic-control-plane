import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, Duration, Fn, Stack } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as yaml from 'js-yaml';

const SRC_DIR = path.join(__dirname, '../../src');
const LAYER_SRC = path.join(SRC_DIR, 'layer');
const OPENAPI_PATH = path.join(__dirname, '../../src/openapi/control-plane-api.yaml');

export interface ControlPlaneApiProps {
  configsBucket: s3.IBucket;
  configTable: dynamodb.ITable;
  launchPackageTable: dynamodb.ITable;
  controlPlaneStateTable: dynamodb.ITable;
}

/**
 * WP-03 / WP-04–10 / WP-12 — Control Plane API CDK Construct.
 *
 * Provisions:
 *   - SfcCpLambdaLayer  (shared sfc_cp_utils layer)
 *   - fn-configs        (config management — WP-04)
 *   - fn-launch-pkg     (launch package assembly — WP-06)
 *   - fn-iot-prov       (IoT provisioning lifecycle — WP-05)
 *   - fn-logs           (CloudWatch log retrieval — WP-07)
 *   - fn-gg-comp        (Greengrass v2 component — WP-09)
 *   - fn-iot-control    (runtime control channel — WP-08)
 *   - fn-agent-remediate (AI remediation — WP-10)
 *   - fn-agent-create-config (AI config generation — WP-10b)
 *   - fn-tag-extract    (tag extraction)
 *   - fn-metrics        (CloudWatch metrics)
 *   - fn-authorizer     (JWT Lambda Authorizer)
 *   - SfcControlPlaneHttpApi (API Gateway HTTP API, OpenAPI import — WP-12)
 */
export class ControlPlaneApi extends Construct {
  public readonly httpApi: apigwv2.CfnApi;
  public readonly layer: lambda.LayerVersion;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  // Individual Lambda functions (exposed for downstream grants)
  public readonly fnConfigs: lambda.Function;
  public readonly fnLaunchPkg: lambda.Function;
  public readonly fnIotProv: lambda.Function;
  public readonly fnLogs: lambda.Function;
  public readonly fnGgComp: lambda.Function;
  public readonly fnIotControl: lambda.Function;
  public readonly fnAgentCreateConfig: lambda.Function;
  public readonly fnAgentRemediate: lambda.Function;
  public readonly fnTagExtract: lambda.Function;
  public readonly fnMetrics: lambda.Function;
  public readonly fnAuthorizer: lambda.Function;

  constructor(scope: Construct, id: string, props: ControlPlaneApiProps) {
    super(scope, id);

    const { configsBucket, configTable, launchPackageTable, controlPlaneStateTable } = props;
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // ── Auth — Cognito User Pool + App Client ──────────────────────────
    this.userPool = new cognito.UserPool(this, 'SfcCpUserPool', {
      userPoolName: 'sfc-control-plane-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: false },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireSymbols: true,
        requireUppercase: true,
        requireLowercase: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });

    // Hosted UI domain (prefix must be globally unique — use account+region)
    this.userPool.addDomain('SfcCpHostedUiDomain', {
      cognitoDomain: {
        domainPrefix: Fn.sub('sfc-cp-${Account}-${Region}', {
          Account: account,
          Region: region,
        }),
      },
    });

    this.userPoolClient = this.userPool.addClient('SfcCpWebClient', {
      userPoolClientName: 'sfc-cp-web',
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ['http://localhost:5173/'],
        logoutUrls: ['http://localhost:5173/'],
      },
      idTokenValidity: Duration.hours(8),
      accessTokenValidity: Duration.hours(8),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // ── WP-03 — Shared Lambda Layer (sfc_cp_utils) ─────────────────────
    this.layer = new lambda.LayerVersion(this, 'SfcCpLayer', {
      code: lambda.Code.fromAsset(LAYER_SRC),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'SFC Control Plane shared utilities (sfc_cp_utils)',
      layerVersionName: 'sfc-cp-utils',
    });

    // ── Common env shared by all Lambda functions ──────────────────────
    const commonEnv: Record<string, string> = {
      CONFIGS_BUCKET_NAME: configsBucket.bucketName,
      CONFIG_TABLE_NAME: configTable.tableName,
      LAUNCH_PKG_TABLE_NAME: launchPackageTable.tableName,
      STATE_TABLE_NAME: controlPlaneStateTable.tableName,
      AWS_ACCOUNT_ID: account,
    };

    // Helper to create a Lambda function with common defaults
    const mkFn = (
      fnId: string,
      handlerFile: string,
      memoryMb = 256,
      timeoutS = 30,
      extraEnv: Record<string, string> = {},
    ): lambda.Function => {
      return new lambda.Function(this, fnId, {
        functionName: fnId,
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: `lambda_handlers.${handlerFile}.handler`,
        code: lambda.Code.fromAsset(SRC_DIR),
        layers: [this.layer],
        memorySize: memoryMb,
        timeout: Duration.seconds(timeoutS),
        environment: { ...commonEnv, ...extraEnv },
        logRetention: logs.RetentionDays.ONE_MONTH,
      });
    };

    // ── WP-04 — fn-configs ─────────────────────────────────────────────
    this.fnConfigs = mkFn('fn-configs', 'config_handler', 256, 30);
    configsBucket.grantReadWrite(this.fnConfigs);
    configTable.grantReadWriteData(this.fnConfigs);
    controlPlaneStateTable.grantReadWriteData(this.fnConfigs);

    // ── WP-05 — fn-iot-prov ────────────────────────────────────────────
    this.fnIotProv = mkFn('fn-iot-prov', 'iot_prov_handler', 128, 30);
    launchPackageTable.grantReadWriteData(this.fnIotProv);
    configsBucket.grantReadWrite(this.fnIotProv);
    this.grantIotProvisioningPermissions(this.fnIotProv, region, account);

    // ── WP-06 — fn-launch-pkg ─────────────────────────────────────────
    this.fnLaunchPkg = mkFn('fn-launch-pkg', 'launch_pkg_handler', 512, 60);
    configsBucket.grantReadWrite(this.fnLaunchPkg);
    configTable.grantReadData(this.fnLaunchPkg);
    launchPackageTable.grantReadWriteData(this.fnLaunchPkg);
    controlPlaneStateTable.grantReadData(this.fnLaunchPkg);
    this.grantIotProvisioningPermissions(this.fnLaunchPkg, region, account);

    // ── WP-07 — fn-logs ────────────────────────────────────────────────
    this.fnLogs = mkFn('fn-logs', 'logs_handler', 256, 30);
    launchPackageTable.grantReadData(this.fnLogs);
    this.fnLogs.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:FilterLogEvents',
          'logs:GetLogEvents',
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
        ],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/sfc/launch-packages/*`,
          `arn:aws:logs:${region}:${account}:log-group:/sfc/launch-packages/*:*`,
        ],
      }),
    );

    // ── WP-08 — fn-iot-control ─────────────────────────────────────────
    this.fnIotControl = mkFn('fn-iot-control', 'iot_control_handler', 128, 15);
    launchPackageTable.grantReadWriteData(this.fnIotControl);
    configsBucket.grantRead(this.fnIotControl);
    this.fnIotControl.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:Publish'],
        resources: [`arn:aws:iot:${region}:${account}:topic/sfc/*/control/*`],
      }),
    );

    // ── WP-09 — fn-gg-comp ─────────────────────────────────────────────
    this.fnGgComp = mkFn('fn-gg-comp', 'gg_comp_handler', 256, 30);
    configsBucket.grantRead(this.fnGgComp);
    launchPackageTable.grantReadWriteData(this.fnGgComp);
    this.fnGgComp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['greengrass:CreateComponentVersion'],
        resources: ['*'],
      }),
    );
    // Greengrass validates the S3 artifact URI during CreateComponentVersion
    configsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowGreengrassArtifactAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('greengrass.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [`${configsBucket.bucketArn}/packages/*`],
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
        },
      }),
    );

    // ── WP-10b — fn-agent-create-config ────────────────────────────────
    this.fnAgentCreateConfig = mkFn('fn-agent-create-config', 'agent_create_config_handler', 256, 300);
    configsBucket.grantReadWrite(this.fnAgentCreateConfig);
    configTable.grantReadWriteData(this.fnAgentCreateConfig);
    controlPlaneStateTable.grantReadWriteData(this.fnAgentCreateConfig);
    this.fnAgentCreateConfig.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: ['*'],
      }),
    );
    this.fnAgentCreateConfig.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter/sfc-config-agent/agentcore-runtime-id`,
        ],
      }),
    );
    // Self-invoke permission (async job dispatch)
    this.fnAgentCreateConfig.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${region}:${account}:function:fn-agent-create-config`,
        ],
      }),
    );

    // ── WP-metrics — fn-metrics ────────────────────────────────────────
    this.fnMetrics = mkFn('fn-metrics', 'metrics_handler', 256, 30);
    this.fnMetrics.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricData'],
        resources: ['*'],
      }),
    );

    // ── Tag Extraction — fn-tag-extract ────────────────────────────────
    this.fnTagExtract = mkFn('fn-tag-extract', 'tag_extract_handler', 256, 60);
    this.fnTagExtract.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );

    // ── WP-10 — fn-agent-remediate ─────────────────────────────────────
    this.fnAgentRemediate = mkFn('fn-agent-remediate', 'agent_remediate_handler', 256, 300);
    configsBucket.grantReadWrite(this.fnAgentRemediate);
    configTable.grantReadWriteData(this.fnAgentRemediate);
    launchPackageTable.grantReadData(this.fnAgentRemediate);
    controlPlaneStateTable.grantReadWriteData(this.fnAgentRemediate);
    this.fnAgentRemediate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: ['*'],
      }),
    );
    this.fnAgentRemediate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter/sfc-config-agent/agentcore-runtime-id`,
        ],
      }),
    );
    this.fnAgentRemediate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:FilterLogEvents',
          'logs:GetLogEvents',
          'logs:DescribeLogGroups',
        ],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/sfc/launch-packages/*`,
          `arn:aws:logs:${region}:${account}:log-group:/sfc/launch-packages/*:*`,
        ],
      }),
    );
    // Self-invoke permission for async job dispatch
    this.fnAgentRemediate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${region}:${account}:function:fn-agent-remediate`,
        ],
      }),
    );

    // ── Auth — fn-authorizer (JWT Lambda Authorizer) ───────────────────
    this.fnAuthorizer = new lambda.Function(this, 'fn-authorizer', {
      functionName: 'fn-authorizer',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'lambda_handlers.jwt_authorizer_handler.handler',
      code: lambda.Code.fromAsset(SRC_DIR),
      layers: [this.layer],
      memorySize: 128,
      timeout: Duration.seconds(10),
      environment: {
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        COGNITO_CLIENT_ID: this.userPoolClient.userPoolClientId,
        AWS_REGION_NAME: region,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    // API Gateway must be able to invoke the authorizer
    this.fnAuthorizer.addPermission('ApiGwInvoke-fn-authorizer', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    // ── WP-12 — API Gateway HTTP API (OpenAPI import) ──────────────────
    const apiLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    // Build substitution map for all ARN placeholders in the spec
    const substitutions: Record<string, string> = {
      FnAuthorizerArn: this.lambdaIntegrationUri(this.fnAuthorizer),
      FnConfigsArn: this.lambdaIntegrationUri(this.fnConfigs),
      FnLaunchPkgArn: this.lambdaIntegrationUri(this.fnLaunchPkg),
      FnIotProvArn: this.lambdaIntegrationUri(this.fnIotProv),
      FnLogsArn: this.lambdaIntegrationUri(this.fnLogs),
      FnGgCompArn: this.lambdaIntegrationUri(this.fnGgComp),
      FnIotControlArn: this.lambdaIntegrationUri(this.fnIotControl),
      FnAgentCreateConfigArn: this.lambdaIntegrationUri(this.fnAgentCreateConfig),
      FnAgentRemediateArn: this.lambdaIntegrationUri(this.fnAgentRemediate),
      FnTagExtractArn: this.lambdaIntegrationUri(this.fnTagExtract),
      FnMetricsArn: this.lambdaIntegrationUri(this.fnMetrics),
      CloudFrontOrigin: 'https://placeholder.cloudfront.net',
    };

    // Parse the OpenAPI YAML spec and substitute CDK token values
    const specRaw = fs.readFileSync(OPENAPI_PATH, 'utf-8');
    const specDict = yaml.load(specRaw) as Record<string, unknown>;
    const substitutedBody = this.substituteInSpec(specDict, substitutions);

    this.httpApi = new apigwv2.CfnApi(this, 'SfcControlPlaneHttpApi', {
      body: substitutedBody,
      failOnWarnings: true,
    });

    // Default stage with auto-deploy and access logging
    new apigwv2.CfnStage(this, 'DefaultStage', {
      apiId: this.httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: apiLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          routeKey: '$context.routeKey',
          status: '$context.status',
          protocol: '$context.protocol',
          responseLength: '$context.responseLength',
          integrationError: '$context.integrationErrorMessage',
        }),
      },
      defaultRouteSettings: {
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
    });

    // Grant API GW permission to invoke each Lambda.
    // sourceArn uses a wildcard API ID — using httpApi.ref here would create
    // a cycle: httpApi (body embeds fn ARNs) → fn → LambdaPermission → httpApi.
    const integrationFunctions = [
      this.fnConfigs,
      this.fnLaunchPkg,
      this.fnIotProv,
      this.fnLogs,
      this.fnGgComp,
      this.fnIotControl,
      this.fnAgentCreateConfig,
      this.fnAgentRemediate,
      this.fnTagExtract,
      this.fnMetrics,
    ];
    for (const fn of integrationFunctions) {
      fn.addPermission(`ApiGwInvoke-${fn.node.id}`, {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: `arn:aws:execute-api:${region}:${account}:*/*`,
      });
    }

    // ── Outputs ────────────────────────────────────────────────────────
    new CfnOutput(this, 'SfcControlPlaneApiUrl', {
      value: Fn.sub('https://${ApiId}.execute-api.${Region}.amazonaws.com/', {
        ApiId: this.httpApi.ref,
        Region: region,
      }),
      description: 'SFC Control Plane API Gateway invoke URL',
    });
    new CfnOutput(this, 'CognitoUserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID for the SFC Control Plane',
    });
    new CfnOutput(this, 'CognitoUserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID (SPA, no secret)',
    });
    new CfnOutput(this, 'CognitoHostedUiDomain', {
      value: Fn.sub(
        'https://sfc-cp-${Account}-${Region}.auth.${Region}.amazoncognito.com',
        { Account: account, Region: region },
      ),
      description: 'Cognito Hosted UI base URL (used by the UI for PKCE login redirects)',
    });

    // ── CDK Nag Suppressions ────────────────────────────────────────────

    // Cognito User Pool — MFA and advanced security not required for this sample
    NagSuppressions.addResourceSuppressions(this.userPool, [
      { id: 'AwsSolutions-COG2', reason: 'MFA not required for this internal control plane sample — email-based account recovery is sufficient.' },
      { id: 'AwsSolutions-COG3', reason: 'Cognito advanced security (threat protection) not required for this sample.' },
    ]);

    // All control-plane Lambda functions — basic execution role + Python 3.12 are intentional
    const allFunctions = [
      this.fnConfigs, this.fnLaunchPkg, this.fnIotProv, this.fnLogs,
      this.fnGgComp, this.fnIotControl, this.fnAgentCreateConfig,
      this.fnAgentRemediate, this.fnTagExtract, this.fnMetrics, this.fnAuthorizer,
    ];
    for (const fn of allFunctions) {
      NagSuppressions.addResourceSuppressions(fn, [
        { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole managed policy is appropriate for all control-plane Lambda functions.' },
        { id: 'AwsSolutions-L1', reason: 'Python 3.12 is the intentional pinned runtime for all control-plane Lambda functions.' },
      ], true);
    }

    // fn-gg-comp — Greengrass CreateComponentVersion does not support resource-level ARNs
    NagSuppressions.addResourceSuppressions(this.fnGgComp, [
      { id: 'AwsSolutions-IAM5', reason: 'greengrass:CreateComponentVersion does not support resource-level ARN scoping.' },
    ], true);

    // fn-metrics — CloudWatch metrics APIs require wildcard resources
    NagSuppressions.addResourceSuppressions(this.fnMetrics, [
      { id: 'AwsSolutions-IAM5', reason: 'cloudwatch:ListMetrics and GetMetricData require wildcard resources — no resource-level scoping supported.' },
    ], true);

    // fn-tag-extract — Bedrock InvokeModel requires wildcard; model ARN not known at deploy time
    NagSuppressions.addResourceSuppressions(this.fnTagExtract, [
      { id: 'AwsSolutions-IAM5', reason: 'bedrock:InvokeModel requires wildcard resources — model ARN is selected at runtime, not known at deploy time.' },
    ], true);

    // fn-agent-create-config, fn-agent-remediate — AgentCore runtime ID not known until after first deploy
    NagSuppressions.addResourceSuppressions(this.fnAgentCreateConfig, [
      { id: 'AwsSolutions-IAM5', reason: 'bedrock-agentcore:InvokeAgentRuntime requires wildcard — AgentCore runtime ID is not known at CDK deploy time.' },
    ], true);
    NagSuppressions.addResourceSuppressions(this.fnAgentRemediate, [
      { id: 'AwsSolutions-IAM5', reason: 'bedrock-agentcore:InvokeAgentRuntime requires wildcard — AgentCore runtime ID is not known at CDK deploy time.' },
    ], true);

    // fn-iot-prov, fn-launch-pkg — IoT provisioning requires dynamic thing/cert/IAM role creation
    NagSuppressions.addResourceSuppressions(this.fnIotProv, [
      { id: 'AwsSolutions-IAM5', reason: 'IoT provisioning requires dynamic creation of IoT things, certificates, policies, and IAM roles — wildcard resources are required.' },
    ], true);
    NagSuppressions.addResourceSuppressions(this.fnLaunchPkg, [
      { id: 'AwsSolutions-IAM5', reason: 'Launch package assembly reuses IoT provisioning permissions that require dynamic resource creation with wildcard ARNs.' },
    ], true);

    // CDK grant* methods (grantReadWrite, grantReadData, grantRead) generate DefaultPolicy
    // entries with wildcard actions (s3:GetBucket*, s3:GetObject*, s3:List*, s3:Abort*,
    // s3:DeleteObject*) and <Bucket.Arn>/* resource wildcards — these are CDK-generated and
    // are the minimum required for the respective grant operations.
    const grantWildcardAppliesTo = [
      'Action::s3:GetBucket*',
      'Action::s3:GetObject*',
      'Action::s3:List*',
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
      'Resource::<SfcAgentArtifactsBucket0ECCD87F.Arn>/*',
    ];
    const ddbIndexWildcard = [
      `Resource::<SfcConfigAgentInfraControlPlaneTablesLaunchPackageTable29C45052.Arn>/index/*`,
    ];

    for (const fn of allFunctions) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK grant* methods generate DefaultPolicy wildcard S3 actions and <Bucket.Arn>/* — these are CDK-generated minimum permissions for the grant operations.',
          appliesTo: grantWildcardAppliesTo,
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK DynamoDB grantRead*/grantReadWriteData generates <Table.Arn>/index/* wildcard for GSI access — CDK-generated.',
          appliesTo: ddbIndexWildcard,
        },
      ], true);
    }

    // Note: fn-logs log-group ARN wildcards and fn-iot-control IoT topic ARN wildcard are
    // suppressed at stack level in sfc-control-plane-stack.ts because CDK Nag resolves
    // region/account tokens to literal values at synth time — appliesTo here won't match.
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** Build the Lambda proxy integration URI for API Gateway. */
  private lambdaIntegrationUri(fn: lambda.Function): string {
    return Fn.sub(
      'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations',
      { FnArn: fn.functionArn },
    );
  }

  /** Grant IoT + IAM permissions required for thing/cert/role creation. */
  private grantIotProvisioningPermissions(
    fn: lambda.Function,
    region: string,
    account: string,
  ): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'iot:CreateThing',
          'iot:DeleteThing',
          'iot:CreateKeysAndCertificate',
          'iot:AttachPolicy',
          'iot:DetachPolicy',
          'iot:AttachThingPrincipal',
          'iot:DetachThingPrincipal',
          'iot:CreatePolicy',
          'iot:DeletePolicy',
          'iot:UpdateCertificate',
          'iot:DeleteCertificate',
          'iot:CreateRoleAlias',
          'iot:DeleteRoleAlias',
          'iot:DescribeRoleAlias',
          'iot:DescribeEndpoint',
        ],
        resources: ['*'],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'iam:CreateRole',
          'iam:GetRole',
          'iam:DeleteRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
          'iam:ListAttachedRolePolicies',
          'iam:ListRolePolicies',
          'iam:GetPolicy',
          'iam:PassRole',
          'iam:TagRole',
        ],
        resources: ['*'],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:DeleteLogGroup'],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/sfc/launch-packages/*`,
        ],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      }),
    );
  }

  /**
   * Recursively walk a parsed YAML/JSON structure and replace every occurrence
   * of `${Key}` in string values with the corresponding CDK token.
   */
  private substituteInSpec(
    obj: unknown,
    substitutions: Record<string, string>,
  ): unknown {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.substituteInSpec(item, substitutions));
    }
    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        result[k] = this.substituteInSpec(v, substitutions);
      }
      return result;
    }
    if (typeof obj === 'string') {
      // If the entire string is a single placeholder, replace it directly
      const fullMatch = obj.match(/^\$\{(\w+)\}$/);
      if (fullMatch && substitutions[fullMatch[1]] !== undefined) {
        return substitutions[fullMatch[1]];
      }
      // Otherwise do an inline text substitution
      return obj.replace(/\$\{(\w+)\}/g, (_, key: string) =>
        substitutions[key] !== undefined ? substitutions[key] : `\${${key}}`,
      );
    }
    return obj;
  }
}
