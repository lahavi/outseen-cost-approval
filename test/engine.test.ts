import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateResource, HOURS_PER_MONTH } from '../src/engine/estimate.ts';
import * as builtIn from '../src/engine/built-in-prices.ts';
import { isUnpriced, type CostEstimate, type PriceBook, type Priced } from '../src/engine/types.ts';

const priced = (p: Priced): CostEstimate => { assert.equal(isUnpriced(p), false, JSON.stringify(p)); return p as CostEstimate; };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.011, `${a} is not ${b}`);

const BOOK: PriceBook = {
  version: 1, region: 'eu-west-1', asOf: '2026-11-14T01:29:26Z',
  ec2: { 'r6g.4xlarge': 0.9024, 'm5.large': 0.107 },
  rds: { 'db.r6g.large': { postgres: 0.252, mysql: 0.237, 'aurora-postgresql': 0.286 } },
  elasticache: { 'cache.r6g.large': 0.229 },
  redshift: { 'ra3.4xlarge': 3.606 },
  sagemaker: { 'ml.t3.medium': 0.055 },
  ebs: { gp3: 0.088, gp2: 0.11 },
  nat: { hourly: 0.048, perGb: 0.048 },
};

test('EC2 from the built-in table in us-east-1: compute plus a 20GB gp3 root volume, MEDIUM range', () => {
  const e = priced(estimateResource({ type: 'EC2', instanceType: 'm5.large' }, 'us-east-1'));
  near(e.breakdown.compute, builtIn.EC2['m5.large'] * HOURS_PER_MONTH);
  near(e.breakdown.storage, 20 * 0.08);
  assert.equal(e.priceSource, 'built-in');
  assert.equal(e.confidence, 'MEDIUM');
  near(e.monthlyLow, e.monthly * 0.8);
  near(e.monthlyHigh, e.monthly * 1.5);
});

test("EC2 from today's price list: exact regional price, narrow range, regional EBS price", () => {
  const e = priced(estimateResource({ type: 'EC2', instanceType: 'r6g.4xlarge', count: 2, rootVolumeSize: 100 }, 'eu-west-1', BOOK));
  near(e.breakdown.compute, 0.9024 * 730 * 2);
  near(e.breakdown.storage, 100 * 0.088 * 2);
  assert.equal(e.priceSource, 'aws-price-list');
  assert.equal(e.confidence, 'HIGH');
  near(e.monthlyHigh, e.monthly * 1.15);
  assert.match(e.summary, /r6g\.4xlarge × 2, 100GB gp3/);
});

test('without a price list, other regions use a multiplier and say the estimate is rough', () => {
  const e = priced(estimateResource({ type: 'EC2', instanceType: 'm5.large' }, 'eu-west-1'));
  near(e.breakdown.compute, builtIn.EC2['m5.large'] * 1.09 * 730);
  assert.equal(e.priceSource, 'built-in-regional-estimate');
  assert.equal(e.confidence, 'LOW');
});

test('an unknown type is never guessed', () => {
  const none = estimateResource({ type: 'EC2', instanceType: 'z9.mega' }, 'us-east-1');
  assert.equal(isUnpriced(none), true);
  // In today's list for the region but missing from it: not offered there, so not priced from the built-in table either.
  const notOffered = estimateResource({ type: 'EC2', instanceType: 'p3.2xlarge' }, 'eu-west-1', BOOK);
  assert.equal(isUnpriced(notOffered), true);
});

test('a price list for another region is ignored', () => {
  const e = priced(estimateResource({ type: 'EC2', instanceType: 'm5.large' }, 'us-east-1', BOOK));
  assert.equal(e.priceSource, 'built-in');
});

test('every estimate leaves out discounts, and Spot is priced at its on-demand ceiling', () => {
  const e = priced(estimateResource({ type: 'EC2', instanceType: 'm5.large', market: 'spot' }, 'us-east-1'));
  assert.ok(e.excludes.some((x) => /Savings Plans/.test(x)));
  assert.ok(e.excludes.some((x) => /Spot discount/.test(x)));
  near(e.breakdown.compute, builtIn.EC2['m5.large'] * 730);
});

test('RDS: Multi-AZ doubles compute; storage and backup are added', () => {
  const e = priced(estimateResource({ type: 'RDS', instanceClass: 'db.r6g.large', engine: 'postgres', allocatedStorage: 100, multiAZ: true }, 'eu-west-1', BOOK));
  near(e.breakdown.compute, 0.252 * 730 * 2);
  near(e.breakdown.storage, 100 * 0.115);
  near(e.breakdown.backup, 150 * 0.095);
});

test('RDS: engines are priced separately, Aurora instances have no fixed storage, licensed engines are not guessed', () => {
  const mysql = priced(estimateResource({ type: 'RDS', instanceClass: 'db.r6g.large', engine: 'mysql' }, 'eu-west-1', BOOK));
  near(mysql.breakdown.compute, 0.237 * 730);
  const aurora = priced(estimateResource({ type: 'RDS', instanceClass: 'db.r6g.large', engine: 'aurora-postgresql' }, 'eu-west-1', BOOK));
  near(aurora.monthly, 0.286 * 730);
  assert.ok(aurora.excludes.some((x) => /Aurora storage/.test(x)));
  assert.equal(isUnpriced(estimateResource({ type: 'RDS', instanceClass: 'db.m5.large', engine: 'oracle-ee' }, 'us-east-1')), true);
  assert.equal(isUnpriced(estimateResource({ type: 'RDS', instanceClass: 'db.m5.large', engine: 'sqlserver-se' }, 'us-east-1')), true);
});

test('EBS: gp3 charges IOPS above 3,000 and throughput above 125 MB/s; io1 charges every IOPS', () => {
  const gp3 = priced(estimateResource({ type: 'EBS', size: 1000, volumeType: 'gp3', iops: 4000, throughput: 250 }, 'us-east-1'));
  near(gp3.breakdown.storage, 80);
  near(gp3.breakdown.iops, 1000 * 0.005);
  near(gp3.breakdown.throughput, 125 * 0.04);
  const io1 = priced(estimateResource({ type: 'EBS', size: 100, volumeType: 'io1', iops: 1000 }, 'us-east-1'));
  near(io1.breakdown.iops, 65);
});

test('NAT gateway, ElastiCache, Redshift and SageMaker use the price list', () => {
  near(priced(estimateResource({ type: 'NAT_GATEWAY' }, 'eu-west-1', BOOK)).monthly, 0.048 * 730 + 100 * 0.048);
  near(priced(estimateResource({ type: 'ELASTICACHE', cacheNodeType: 'cache.r6g.large', numCacheNodes: 3 }, 'eu-west-1', BOOK)).monthly, 0.229 * 730 * 3);
  near(priced(estimateResource({ type: 'REDSHIFT', nodeType: 'ra3.4xlarge', numberOfNodes: 2 }, 'eu-west-1', BOOK)).monthly, 3.606 * 730 * 2);
  near(priced(estimateResource({ type: 'SAGEMAKER', instanceType: 'ml.t3.medium' }, 'eu-west-1', BOOK)).monthly, 0.055 * 730 + 5 * 0.14);
});

test('EKS: the cluster is its control-plane fee; a node group is its nodes without the fee', () => {
  near(priced(estimateResource({ type: 'EKS', kind: 'cluster' }, 'us-east-1')).monthly, 73);
  const ng = priced(estimateResource({ type: 'EKS', kind: 'nodegroup', instanceTypes: ['m5.large'], desiredSize: 3 }, 'eu-west-1', BOOK));
  near(ng.monthly, 0.107 * 730 * 3);
});

test('usage-based resources are marked as assumptions with a wide range', () => {
  for (const config of [{ type: 'S3' } as const, { type: 'RDS_AURORA', engine: 'aurora-postgresql', engineMode: 'serverless' } as const]) {
    const e = priced(estimateResource(config, 'us-east-1'));
    assert.equal(e.priceSource, 'usage-assumption');
    assert.equal(e.confidence, 'LOW');
  }
});
