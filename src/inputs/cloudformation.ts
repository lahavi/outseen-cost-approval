// Reads the resources a CloudFormation template would create (JSON or YAML).

import { parse } from 'yaml';
import type { ResourceConfig } from '../engine/types.ts';
import type { FoundResource } from '../report.ts';
import type { PlanScan } from './terraform-plan.ts';

/** JSON first, then YAML. `!Ref X` becomes { Ref: 'X' }; other short-form tags are left unresolved. */
export function parseTemplate(text: string): any {
  try { return JSON.parse(text); } catch { /* not JSON */ }
  return parse(text, {
    logLevel: 'error',
    customTags: [{ tag: '!Ref', resolve: (value: string) => ({ Ref: value }) }],
  });
}

const COMPUTED = 'its size is set by a parameter without a default, or computed';

export function scanCloudFormation(template: any, region: string): PlanScan {
  const params = template?.Parameters ?? {};
  /** A literal, or a parameter's default; undefined for anything computed. */
  const lit = (v: any): string | number | boolean | undefined => {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v && typeof v === 'object' && typeof v.Ref === 'string') return lit(params[v.Ref]?.Default);
    return undefined;
  };
  const str = (v: any): string | undefined => {
    const x = lit(v);
    return x === undefined || x === '' ? undefined : String(x);
  };
  const num = (v: any): number | undefined => {
    const x = lit(v);
    const n = Number(x);
    return x === undefined || x === '' || !Number.isFinite(n) ? undefined : n;
  };

  const readers: Record<string, (p: any) => ResourceConfig | string> = {
    'AWS::EC2::Instance': (p) => {
      const instanceType = str(p.InstanceType);
      if (!instanceType) {
        return p.InstanceType === undefined ? 'no InstanceType given (it comes from a launch template or the default)' : COMPUTED;
      }
      const ebs = (Array.isArray(p.BlockDeviceMappings) ? p.BlockDeviceMappings[0]?.Ebs : undefined) ?? {};
      return { type: 'EC2', instanceType, rootVolumeSize: num(ebs.VolumeSize), rootVolumeType: str(ebs.VolumeType) };
    },
    'AWS::RDS::DBInstance': (p) => {
      const instanceClass = str(p.DBInstanceClass);
      if (!instanceClass) return COMPUTED;
      const multiAZ = lit(p.MultiAZ);
      return {
        type: 'RDS', instanceClass, engine: str(p.Engine) ?? 'postgres',
        allocatedStorage: num(p.AllocatedStorage), multiAZ: multiAZ === true || multiAZ === 'true', iops: num(p.Iops),
      };
    },
    'AWS::RDS::DBCluster': (p) =>
      str(p.EngineMode) === 'serverless' || p.ServerlessV2ScalingConfiguration
        ? { type: 'RDS_AURORA', engine: str(p.Engine) ?? 'aurora', engineMode: 'serverless' }
        : 'the cluster itself has no hourly charge; its instances are priced separately',
    'AWS::EC2::Volume': (p) => {
      const size = num(p.Size);
      if (size === undefined) return p.Size === undefined ? 'the size comes from a snapshot' : COMPUTED;
      return { type: 'EBS', size, volumeType: str(p.VolumeType) ?? 'gp2', iops: num(p.Iops), throughput: num(p.Throughput) };
    },
    'AWS::EC2::NatGateway': () => ({ type: 'NAT_GATEWAY' }),
    'AWS::ElastiCache::CacheCluster': (p) => {
      const cacheNodeType = str(p.CacheNodeType);
      if (!cacheNodeType) return COMPUTED;
      return { type: 'ELASTICACHE', cacheNodeType, numCacheNodes: num(p.NumCacheNodes) ?? 1 };
    },
    'AWS::ElastiCache::ReplicationGroup': (p) => {
      const cacheNodeType = str(p.CacheNodeType);
      if (!cacheNodeType) return COMPUTED;
      const nodes = num(p.NumCacheClusters) ?? (num(p.NumNodeGroups) ?? 1) * ((num(p.ReplicasPerNodeGroup) ?? 0) + 1);
      return { type: 'ELASTICACHE', cacheNodeType, numCacheNodes: nodes };
    },
    'AWS::Redshift::Cluster': (p) => {
      const nodeType = str(p.NodeType);
      if (!nodeType) return COMPUTED;
      return { type: 'REDSHIFT', nodeType, numberOfNodes: num(p.NumberOfNodes) ?? 1 };
    },
    'AWS::EKS::Cluster': () => ({ type: 'EKS', kind: 'cluster' }),
    'AWS::EKS::Nodegroup': (p) => {
      const types = Array.isArray(p.InstanceTypes) ? p.InstanceTypes.map((t: any) => str(t)) : [];
      return {
        type: 'EKS', kind: 'nodegroup',
        instanceTypes: types.length && types.every(Boolean) ? types : ['t3.medium'],
        desiredSize: num(p.ScalingConfig?.DesiredSize) ?? 2,
      };
    },
    'AWS::SageMaker::NotebookInstance': (p) => {
      const instanceType = str(p.InstanceType);
      if (!instanceType) return COMPUTED;
      return { type: 'SAGEMAKER', instanceType, volumeSizeInGB: num(p.VolumeSizeInGB) };
    },
    'AWS::S3::Bucket': () => ({ type: 'S3' }),
  };

  const scan: PlanScan = { resources: [], notCovered: {} };
  for (const [id, res] of Object.entries<any>(template?.Resources ?? {})) {
    const type = res?.Type;
    if (typeof type !== 'string' || !type.startsWith('AWS::')) continue;
    const reader = readers[type];
    if (!reader) { scan.notCovered[type] = (scan.notCovered[type] ?? 0) + 1; continue; }
    const read = reader(res.Properties ?? {});
    const found: FoundResource = typeof read === 'string' ? { name: id, region, unreadable: read } : { name: id, region, config: read };
    scan.resources.push(found);
  }
  return scan;
}
