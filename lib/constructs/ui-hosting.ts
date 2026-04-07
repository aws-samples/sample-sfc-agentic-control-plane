/**
 * WP-18 — CloudFront + S3 UI Hosting CDK Construct (TypeScript)
 *
 * Provisions:
 *   - CloudFront distribution with two origins:
 *       * S3 (OAC)  — serves static SPA from <artifactsBucket>/ui/ prefix (default origin)
 *       * API GW    — forwards /api/* to the HTTP API (no cache)
 *   - Origin Access Control (OAC) for the S3 origin (SigV4, replaces legacy OAI)
 *   - S3 bucket policy: ONLY CloudFront (this specific distribution) may read ui/* objects
 *   - Custom error responses for SPA client-side routing (403/404 → 200 /index.html)
 *   - HTTPS-only viewer protocol policy (redirect HTTP → HTTPS)
 *   - No S3 static website hosting — bucket remains a private, locked-down object store
 */

import { CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface UiHostingProps {
  /** The existing private S3 bucket that also holds agent artifacts.
   *  UI assets are stored under the `ui/` key prefix within this bucket. */
  artifactsBucket: s3.IBucket;
  /** The HTTP API Gateway CfnApi resource. */
  httpApi: apigwv2.CfnApi;
}

/**
 * CloudFront distribution that serves the SFC Control Plane SPA.
 *
 * Security posture:
 *   - S3 bucket has BlockPublicAccess.BLOCK_ALL (enforced by parent construct)
 *   - No S3 website hosting feature is used
 *   - Bucket policy grants s3:GetObject on ui/* ONLY to this CloudFront distribution
 *     via OAC with SourceArn condition — no other principal can read the assets
 *   - CloudFront enforces HTTPS-only viewer connections
 */
export class UiHosting extends Construct {
  /** The CloudFront CfnDistribution resource. */
  public readonly distribution: cf.CfnDistribution;
  /** Full HTTPS URL of the CloudFront distribution (https://dXXXX.cloudfront.net/). */
  public readonly distributionUrl: string;
  /** Bare domain name of the CloudFront distribution (dXXXX.cloudfront.net). */
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: UiHostingProps) {
    super(scope, id);

    const { artifactsBucket, httpApi } = props;
    const account = Stack.of(this).account;
    const region = Stack.of(this).region;

    // ── Origin Access Control (OAC) ───────────────────────────────────
    // Uses SigV4 signing — CloudFront authenticates every S3 request.
    // This replaces the legacy Origin Access Identity (OAI) mechanism.
    const oac = new cf.CfnOriginAccessControl(this, 'SfcUiOac', {
      originAccessControlConfig: {
        name: 'SfcControlPlaneUiOac',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        description: 'OAC for SFC Control Plane UI S3 origin',
      },
    });

    // ── CloudFront Distribution (L1 CfnDistribution) ──────────────────
    // We use L1 because CDK L2 Distribution does not support OAC natively.
    this.distribution = new cf.CfnDistribution(this, 'SfcUiDistribution', {
      distributionConfig: {
        enabled: true,
        defaultRootObject: 'index.html',
        priceClass: 'PriceClass_100',
        httpVersion: 'http2',
        comment: 'SFC Control Plane UI',

        // ── Origins ──────────────────────────────────────────────────
        origins: [
          // S3 origin — serves SPA static assets from the ui/ prefix.
          // OAC is attached; originAccessIdentity must be empty string when using OAC.
          {
            id: 'S3UiOrigin',
            domainName: artifactsBucket.bucketRegionalDomainName,
            originPath: '/ui',
            s3OriginConfig: {
              originAccessIdentity: '', // empty = use OAC instead
            },
            originAccessControlId: oac.ref,
          },
          // API Gateway origin — proxies /api/* requests without caching.
          {
            id: 'ApiGwOrigin',
            domainName: `${httpApi.ref}.execute-api.${region}.amazonaws.com`,
            customOriginConfig: {
              httpsPort: 443,
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1.2'],
            },
          },
        ],

        // ── Cache Behaviours ─────────────────────────────────────────
        defaultCacheBehavior: {
          targetOriginId: 'S3UiOrigin',
          viewerProtocolPolicy: 'redirect-to-https',
          cachePolicyId: cf.CachePolicy.CACHING_OPTIMIZED.cachePolicyId,
          compress: true,
          allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
          cachedMethods: ['GET', 'HEAD'],
        },
        cacheBehaviors: [
          {
            pathPattern: '/api/*',
            targetOriginId: 'ApiGwOrigin',
            viewerProtocolPolicy: 'redirect-to-https',
            cachePolicyId: cf.CachePolicy.CACHING_DISABLED.cachePolicyId,
            originRequestPolicyId:
              cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
            allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
            cachedMethods: ['GET', 'HEAD'],
            compress: false,
          },
        ],

        // ── SPA client-side routing ───────────────────────────────────
        // S3 returns 403 (object not found via OAC) for unknown paths.
        // Map both 403 and 404 back to index.html so React Router works.
        customErrorResponses: [
          {
            errorCode: 403,
            responseCode: 200,
            responsePagePath: '/index.html',
            errorCachingMinTtl: 0,
          },
          {
            errorCode: 404,
            responseCode: 200,
            responsePagePath: '/index.html',
            errorCachingMinTtl: 0,
          },
        ],

        // ── Viewer certificate (CloudFront default HTTPS) ─────────────
        viewerCertificate: {
          cloudFrontDefaultCertificate: true,
        },
      },
    });

    this.distributionDomainName = this.distribution.attrDomainName;
    this.distributionUrl = Fn.join('', ['https://', this.distributionDomainName, '/']);

    // ── S3 Bucket Policy ──────────────────────────────────────────────
    // Grant s3:GetObject on the ui/* prefix ONLY to this CloudFront distribution.
    // The AWS:SourceArn condition pins the grant to this specific distribution —
    // not to any CloudFront distribution in the account.
    // No other principal (including anonymous/public) can read ui/* objects.
    artifactsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontOACReadUiAssets',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [`${artifactsBucket.bucketArn}/ui/*`],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': Fn.join('', [
              `arn:aws:cloudfront::${account}:distribution/`,
              this.distribution.ref,
            ]),
          },
        },
      }),
    );

    // ── Output ────────────────────────────────────────────────────────
    new CfnOutput(this, 'SfcControlPlaneUiUrl', {
      value: this.distributionUrl,
      description: 'SFC Control Plane UI — CloudFront URL',
    });

    // ── CDK Nag Suppressions ──────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(this.distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'Geo-restriction not required — global access is intended for this sample.' },
      { id: 'AwsSolutions-CFR2', reason: 'WAF integration not required for this sample internal control plane UI.' },
      { id: 'AwsSolutions-CFR3', reason: 'CloudFront access logging not required for this sample.' },
      { id: 'AwsSolutions-CFR4', reason: 'Default CloudFront certificate used — no custom domain is configured in this sample.' },
    ]);
  }
}
