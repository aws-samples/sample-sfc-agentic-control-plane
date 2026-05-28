import * as path from 'path';
import { Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/**
 * SfcTelemetryRule CDK Construct.
 *
 * IoT Topic Rule that listens for channel telemetry MQTT messages published by
 * the edge runner on topic  sfc/{packageId}/telemetry  and invokes a Lambda
 * function to persist the batch to the TelemetryTable.
 *
 * IoT SQL:
 *   SELECT *, topic(2) AS packageId FROM 'sfc/+/telemetry'
 */
export interface SfcTelemetryRuleProps {
  telemetryTable: dynamodb.ITable;
  layer: lambda.ILayerVersion;
}

export class SfcTelemetryRule extends Construct {
  public readonly fnTelemetryIngestion: lambda.Function;
  public readonly rule: iot.CfnTopicRule;

  constructor(scope: Construct, id: string, props: SfcTelemetryRuleProps) {
    super(scope, id);

    const { telemetryTable, layer } = props;
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // ── Lambda: telemetry ingestion ───────────────────────────────────
    this.fnTelemetryIngestion = new lambda.Function(this, 'fn-telemetry-ingestion', {
      functionName: 'fn-telemetry-ingestion',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'lambda_handlers.telemetry_ingestion_handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src')),
      layers: [layer],
      memorySize: 128,
      timeout: Duration.seconds(15),
      environment: {
        TELEMETRY_TABLE_NAME: telemetryTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    telemetryTable.grantWriteData(this.fnTelemetryIngestion);

    // ── IAM role for the IoT Rule Action ──────────────────────────────
    const ruleRole = new iam.Role(this, 'TelemetryRuleRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'Allows IoT telemetry rule to invoke the telemetry ingestion Lambda',
    });
    ruleRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.fnTelemetryIngestion.functionArn],
      }),
    );

    // Allow IoT Core to invoke the Lambda (resource-based policy)
    this.fnTelemetryIngestion.addPermission('IoTRuleInvoke', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      sourceArn: `arn:aws:iot:${region}:${account}:rule/*`,
    });

    // ── IoT Topic Rule ────────────────────────────────────────────────
    this.rule = new iot.CfnTopicRule(this, 'SfcTelemetryRule', {
      topicRulePayload: {
        sql: "SELECT *, topic(2) AS packageId FROM 'sfc/+/telemetry'",
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [
          {
            lambda: {
              functionArn: this.fnTelemetryIngestion.functionArn,
            },
          },
        ],
        errorAction: {
          republish: {
            roleArn: ruleRole.roleArn,
            topic: 'sfc/errors/telemetry-rule',
            qos: 0,
          },
        },
      },
    });

    // ── CDK Nag Suppressions ──────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(this.fnTelemetryIngestion, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole managed policy is appropriate for the telemetry ingestion Lambda.' },
      { id: 'AwsSolutions-L1', reason: 'Python 3.12 is the intentional pinned runtime for the telemetry ingestion Lambda.' },
    ], true);
  }
}
