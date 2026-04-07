import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * WP-01: DynamoDB tables for the SFC Control Plane.
 *
 * Creates:
 *   - LaunchPackageTable  (PK: packageId, SK: createdAt, GSI: configId-index)
 *   - ControlPlaneStateTable (PK: stateKey — singleton "global")
 */
export class LaunchPackageTables extends Construct {
  public readonly launchPackageTable: dynamodb.Table;
  public readonly controlPlaneStateTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // ── LaunchPackageTable ──────────────────────────────────────────────
    this.launchPackageTable = new dynamodb.Table(this, 'LaunchPackageTable', {
      tableName: 'SFC_Launch_Packages',
      partitionKey: { name: 'packageId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // WARNING: RETAIN prevents accidental permanent data loss on `cdk destroy`.
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // GSI: look up packages by configId
    this.launchPackageTable.addGlobalSecondaryIndex({
      indexName: 'configId-index',
      partitionKey: { name: 'configId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── ControlPlaneStateTable ─────────────────────────────────────────
    this.controlPlaneStateTable = new dynamodb.Table(this, 'ControlPlaneStateTable', {
      tableName: 'SFC_ControlPlane_State',
      partitionKey: { name: 'stateKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // WARNING: RETAIN prevents accidental permanent data loss on `cdk destroy`.
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // ── Outputs ────────────────────────────────────────────────────────
    new CfnOutput(this, 'LaunchPackageTableName', {
      value: this.launchPackageTable.tableName,
      description: 'DynamoDB table for SFC Launch Packages',
    });
    new CfnOutput(this, 'LaunchPackageTableArn', {
      value: this.launchPackageTable.tableArn,
      description: 'DynamoDB table ARN for SFC Launch Packages',
    });
    new CfnOutput(this, 'ControlPlaneStateTableName', {
      value: this.controlPlaneStateTable.tableName,
      description: 'DynamoDB singleton state table for SFC Control Plane',
    });
    new CfnOutput(this, 'ControlPlaneStateTableArn', {
      value: this.controlPlaneStateTable.tableArn,
      description: 'DynamoDB singleton state table ARN for SFC Control Plane',
    });
  }
}
