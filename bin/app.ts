#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SfcAgenticControlPlaneStack } from '../lib/sfc-control-plane-stack';

const app = new cdk.App();

const account =
  app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT;
const region =
  app.node.tryGetContext('region') ??
  process.env.CDK_DEFAULT_REGION ??
  'us-east-1';

new SfcAgenticControlPlaneStack(app, 'SfcAgenticControlPlaneStack', {
  description: 'SFC Config Agent — Agentic Control Plane',
  env: { account, region },
});

app.synth();
