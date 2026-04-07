/**
 * UiStack — NestedStack for CloudFront UI hosting + UI CodeBuild pipeline.
 *
 * Placing CloudFront in a NestedStack breaks the circular dependency that
 * exists when everything is in one flat template:
 *
 *   httpApi (body → fn ARNs) → fn-authorizer (env → CpWebClient)
 *   → CpWebClient (callbackUrls → cfUrl token) → UiDistribution (origin → httpApi.ref)
 *
 * In a NestedStack, the parent passes httpApi.ref as a plain CFN Parameter.
 * The parent template sees `AWS::CloudFormation::Stack` with a parameter value
 * — not an inline token edge — so there is no cycle in the parent graph.
 *
 * Provisions:
 *   - CloudFront distribution (OAC, S3 + API GW origins)
 *   - OAC S3 bucket policy on the shared artifacts bucket
 *   - SSM parameter /sfc-config-agent/cf-distribution-domain
 *   - CodeBuild project that builds the Vite SPA (all env resolved at runtime)
 *   - CustomResource trigger that fires the build after the stack is created
 *     The build is the "final step": resolves CF domain from SSM, writes all
 *     VITE_ vars, runs npm build, syncs to S3, and updates Cognito callback URLs.
 */

import {
  CustomResource,
  Duration,
  NestedStack,
  NestedStackProps,
  aws_codebuild as codebuild,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';
import { UiHosting } from './constructs/ui-hosting';

export interface UiStackProps extends NestedStackProps {
  artifactsBucket: s3.IBucket;
  sourceBucket: s3.IBucket;
  httpApi: apigwv2.CfnApi;
  /** Vite env — plain resolved strings, no CF-token dependency */
  viteApiBaseUrl: string;
  viteCognitoDomain: string;
  viteCognitoClientId: string;
  /** Cognito identifiers for the post_build update-user-pool-client call */
  userPoolId: string;
  userPoolArn: string;
  userPoolClientId: string;
  region: string;
  account: string;
}

export class UiStack extends NestedStack {
  public readonly distributionDomainName: string;
  public readonly distributionUrl: string;

  constructor(scope: Construct, id: string, props: UiStackProps) {
    super(scope, id, props);

    const {
      artifactsBucket, sourceBucket, httpApi,
      viteApiBaseUrl, viteCognitoDomain, viteCognitoClientId,
      userPoolId, userPoolArn, userPoolClientId,
      region, account,
    } = props;

    // ── CloudFront distribution + OAC bucket policy ───────────────────
    const uiHosting = new UiHosting(this, 'UiHosting', { artifactsBucket, httpApi });
    this.distributionDomainName = uiHosting.distributionDomainName;
    this.distributionUrl = uiHosting.distributionUrl;

    // ── SSM: CF domain — read by CodeBuild at build-time ─────────────
    // Storing as SSM (not CFN token) keeps the CodeBuild project free of
    // any CFN dependency edge back to the CloudFront distribution.
    const cfDomainSsmParamName = '/sfc-config-agent/cf-distribution-domain';
    new ssm.StringParameter(this, 'SfcCfDistributionDomainParam', {
      parameterName: cfDomainSsmParamName,
      stringValue: uiHosting.distributionDomainName,
      description: 'CloudFront distribution domain for the SFC Control Plane UI',
    });

    // ── UI CodeBuild IAM role ─────────────────────────────────────────
    const uiBuildRole = new iam.Role(this, 'SfcUiBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    uiBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));
    uiBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resources: [sourceBucket.bucketArn, `${sourceBucket.bucketArn}/*`],
    }));
    uiBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [artifactsBucket.bucketArn, `${artifactsBucket.bucketArn}/ui/*`],
    }));
    // Read CF domain from SSM at build-time (param name = plain literal, no token dep)
    uiBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${cfDomainSsmParamName}`],
    }));
    // Update Cognito callback/logout URLs in post_build (final step)
    uiBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:UpdateUserPoolClient', 'cognito-idp:DescribeUserPoolClient'],
      resources: [userPoolArn],
    }));

    // ── UI CodeBuild project ──────────────────────────────────────────
    const uiBuildProject = new codebuild.Project(this, 'SfcUiBuildProject', {
      projectName: `${this.stackName}-ui-build`,
      role: uiBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          VITE_API_BASE_URL:      { value: viteApiBaseUrl },
          VITE_COGNITO_DOMAIN:    { value: viteCognitoDomain },
          VITE_COGNITO_CLIENT_ID: { value: viteCognitoClientId },
          // Plain SSM param name — no CloudFront token, no CFN cycle
          CF_DOMAIN_SSM_PARAM:    { value: cfDomainSsmParamName },
          ARTIFACTS_BUCKET:       { value: artifactsBucket.bucketName },
          COGNITO_USER_POOL_ID:   { value: userPoolId },
          COGNITO_CLIENT_ID:      { value: userPoolClientId },
          // Explicit region — used in aws cli calls (no implicit env var assumption)
          DEPLOY_REGION:          { value: region },
        },
      },
      source: codebuild.Source.s3({ bucket: sourceBucket, path: '' }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: '20' },
            commands: [
              'if [ -f repo ]; then unzip -q repo -d . && echo Extracted repo; fi',
              'cd src/ui && npm install',
            ],
          },
          pre_build: {
            commands: [
              // Resolve CF domain from SSM — plain literal param name, zero CFN dep edge
              // --region uses the explicitly injected DEPLOY_REGION env var (set at synth time)
              'CF_DOMAIN=$(aws ssm get-parameter --name "$CF_DOMAIN_SSM_PARAM" --region "$DEPLOY_REGION" --query "Parameter.Value" --output text)',
              'export VITE_COGNITO_REDIRECT_URI="https://$CF_DOMAIN/"',
              'echo "CF redirect URI: $VITE_COGNITO_REDIRECT_URI"',
            ],
          },
          build: {
            commands: [
              'echo "VITE_API_BASE_URL=$VITE_API_BASE_URL"                  > .env.production',
              'echo "VITE_COGNITO_DOMAIN=$VITE_COGNITO_DOMAIN"             >> .env.production',
              'echo "VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID"       >> .env.production',
              'echo "VITE_COGNITO_REDIRECT_URI=$VITE_COGNITO_REDIRECT_URI" >> .env.production',
              'npm run build',
            ],
          },
          post_build: {
            commands: [
              // 1. Sync built assets to S3
              // Note: build phase already cd'd into src/ui, so dist/ is the correct relative path
              'aws s3 sync dist/ s3://$ARTIFACTS_BUCKET/ui/ --delete --cache-control "max-age=31536000,immutable"',
              'aws s3 cp dist/index.html s3://$ARTIFACTS_BUCKET/ui/index.html --cache-control "no-cache, no-store, must-revalidate"',
              // 2. Final step: update Cognito app-client with the real CloudFront callback URL
              'CF_URL="https://$CF_DOMAIN/"',
              'aws cognito-idp update-user-pool-client --user-pool-id "$COGNITO_USER_POOL_ID" --client-id "$COGNITO_CLIENT_ID" --callback-urls "http://localhost:5173/" "$CF_URL" --logout-urls "http://localhost:5173/" "$CF_URL" --allowed-o-auth-flows "code" --allowed-o-auth-scopes "openid" "email" "profile" --allowed-o-auth-flows-user-pool-client --supported-identity-providers "COGNITO"',
              'echo "Cognito callback URLs updated → $CF_URL"',
            ],
          },
        },
        cache: { paths: ['ui/node_modules/**/*'] },
      }),
      timeout: Duration.minutes(20),
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM),
    });

    // ── Trigger Lambda — starts the CodeBuild job via CustomResource ──
    const triggerFn = new lambda.Function(this, 'SfcUiBuildTriggerFn', {
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
      resources: [uiBuildProject.projectArn],
    }));

    // Fires after CloudFront + SSM param are fully provisioned in this nested stack
    new CustomResource(this, 'SfcUiBuildTrigger', {
      serviceToken: triggerFn.functionArn,
      properties: { ProjectName: uiBuildProject.projectName, BuildVersion: '1' },
    });
  }
}
