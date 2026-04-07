import * as path from 'path';
import { Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * WP-08b — SfcHeartbeatRule CDK Construct.
 *
 * IoT Topic Rule that listens for heartbeat MQTT messages published by the
 * edge runner on topic  sfc/{packageId}/heartbeat  and invokes a Lambda
 * function to persist the heartbeat to the LaunchPackageTable.
 *
 * IoT SQL:
 *   SELECT *, topic(2) AS packageId FROM 'sfc/+/heartbeat'
 */
export interface SfcHeartbeatRuleProps {
  launchPackageTable: dynamodb.ITable;
  layer: lambda.ILayerVersion;
}

export class SfcHeartbeatRule extends Construct {
  public readonly fnHeartbeat: lambda.Function;
  public readonly rule: iot.CfnTopicRule;

  constructor(scope: Construct, id: string, props: SfcHeartbeatRuleProps) {
    super(scope, id);

    const { launchPackageTable, layer } = props;
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // ── Lambda: heartbeat ingestion ────────────────────────────────────
    this.fnHeartbeat = new lambda.Function(this, 'fn-heartbeat-ingestion', {
      functionName: 'fn-heartbeat-ingestion',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'lambda_handlers.heartbeat_ingestion_handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src')),
      layers: [layer],
      memorySize: 128,
      timeout: Duration.seconds(15),
      environment: {
        LAUNCH_PKG_TABLE_NAME: launchPackageTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Grant the Lambda Query + UpdateItem on the LaunchPackageTable
    launchPackageTable.grantReadWriteData(this.fnHeartbeat);

    // ── IAM role for the IoT Rule Action ──────────────────────────────
    const ruleRole = new iam.Role(this, 'HeartbeatRuleRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'Allows IoT heartbeat rule to invoke the heartbeat ingestion Lambda',
    });
    ruleRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.fnHeartbeat.functionArn],
      }),
    );

    // Allow IoT Core to invoke the Lambda (resource-based policy)
    this.fnHeartbeat.addPermission('IoTRuleInvoke', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      sourceArn: `arn:aws:iot:${region}:${account}:rule/*`,
    });

    // ── IoT Topic Rule ────────────────────────────────────────────────
    this.rule = new iot.CfnTopicRule(this, 'SfcHeartbeatRule', {
      topicRulePayload: {
        sql: "SELECT *, topic(2) AS packageId FROM 'sfc/+/heartbeat'",
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [
          {
            lambda: {
              functionArn: this.fnHeartbeat.functionArn,
            },
          },
        ],
        // Error action: republish to a dedicated error topic for debugging
        errorAction: {
          republish: {
            roleArn: ruleRole.roleArn,
            topic: 'sfc/errors/heartbeat-rule',
            qos: 0,
          },
        },
      },
    });
  }
}
