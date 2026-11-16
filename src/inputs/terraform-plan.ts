// Reads the resources a Terraform plan would create, from `terraform show -json <planfile>`.

import type { ResourceConfig } from '../engine/types.ts';
import type { FoundResource } from '../report.ts';
import { isRegion } from '../prices.ts';

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v
    : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const block = (v: unknown): any => (Array.isArray(v) ? v[0] ?? {} : v ?? {});
const UNKNOWN = 'its size is not known until apply';

type Reader = (after: any) => ResourceConfig | string;

/** Terraform resource type → its config, or a sentence saying why it can't be read. */
const READERS: Record<string, Reader> = {
  aws_instance: (a) => {
    const instanceType = str(a.instance_type);
    if (!instanceType) return UNKNOWN;
    const root = block(a.root_block_device);
    return {
      type: 'EC2', instanceType,
      rootVolumeSize: num(root.volume_size), rootVolumeType: str(root.volume_type),
      market: block(a.instance_market_options).market_type === 'spot' || a.spot_price ? 'spot' : undefined,
    };
  },
  aws_db_instance: (a) => {
    const instanceClass = str(a.instance_class);
    if (!instanceClass) return UNKNOWN;
    return {
      type: 'RDS', instanceClass, engine: str(a.engine) ?? 'postgres',
      allocatedStorage: num(a.allocated_storage), multiAZ: a.multi_az === true, iops: num(a.iops),
    };
  },
  aws_rds_cluster_instance: (a) => {
    const instanceClass = str(a.instance_class);
    if (!instanceClass) return UNKNOWN;
    if (instanceClass === 'db.serverless') return { type: 'RDS_AURORA', engine: str(a.engine) ?? 'aurora', engineMode: 'serverless' };
    return { type: 'RDS', instanceClass, engine: str(a.engine) ?? 'aurora-postgresql' };
  },
  aws_rds_cluster: (a) =>
    a.engine_mode === 'serverless'
      ? { type: 'RDS_AURORA', engine: str(a.engine) ?? 'aurora', engineMode: 'serverless' }
      : 'the cluster itself has no hourly charge; its instances are priced separately',
  aws_ebs_volume: (a) => {
    const size = num(a.size);
    if (size === undefined) return 'the size comes from a snapshot';
    return { type: 'EBS', size, volumeType: str(a.type) ?? 'gp2', iops: num(a.iops), throughput: num(a.throughput) };
  },
  aws_nat_gateway: () => ({ type: 'NAT_GATEWAY' }),
  aws_elasticache_cluster: (a) => {
    const cacheNodeType = str(a.node_type);
    if (!cacheNodeType) return UNKNOWN;
    return { type: 'ELASTICACHE', cacheNodeType, numCacheNodes: num(a.num_cache_nodes) ?? 1 };
  },
  aws_elasticache_replication_group: (a) => {
    const cacheNodeType = str(a.node_type);
    if (!cacheNodeType) return UNKNOWN;
    const nodes = num(a.num_cache_clusters) ?? (num(a.num_node_groups) ?? 1) * ((num(a.replicas_per_node_group) ?? 0) + 1);
    return { type: 'ELASTICACHE', cacheNodeType, numCacheNodes: nodes };
  },
  aws_redshift_cluster: (a) => {
    const nodeType = str(a.node_type);
    if (!nodeType) return UNKNOWN;
    return { type: 'REDSHIFT', nodeType, numberOfNodes: num(a.number_of_nodes) ?? 1 };
  },
  aws_eks_cluster: () => ({ type: 'EKS', kind: 'cluster' }),
  aws_eks_node_group: (a) => ({
    type: 'EKS', kind: 'nodegroup',
    instanceTypes: Array.isArray(a.instance_types) && a.instance_types.length ? a.instance_types.map(String) : ['t3.medium'],
    desiredSize: num(block(a.scaling_config).desired_size) ?? 2,
  }),
  aws_sagemaker_notebook_instance: (a) => {
    const instanceType = str(a.instance_type);
    if (!instanceType) return UNKNOWN;
    return { type: 'SAGEMAKER', instanceType, volumeSizeInGB: num(a.volume_size) };
  },
  aws_s3_bucket: () => ({ type: 'S3' }),
};

export interface PlanScan {
  resources: FoundResource[];
  /** AWS resource types being created that this tool does not price, with how many of each. */
  notCovered: Record<string, number>;
}

export function scanTerraformPlan(plan: any, defaultRegion: string): PlanScan {
  const configured = plan?.configuration?.provider_config?.aws?.expressions?.region?.constant_value;
  const region = typeof configured === 'string' && isRegion(configured) ? configured : defaultRegion;
  const scan: PlanScan = { resources: [], notCovered: {} };

  for (const rc of plan?.resource_changes ?? []) {
    if (rc?.mode !== 'managed' || !Array.isArray(rc.change?.actions) || !rc.change.actions.includes('create')) continue;
    if (typeof rc.type !== 'string' || !rc.type.startsWith('aws_')) continue;
    const reader = READERS[rc.type];
    if (!reader) { scan.notCovered[rc.type] = (scan.notCovered[rc.type] ?? 0) + 1; continue; }
    const read = reader(rc.change.after ?? {});
    scan.resources.push(typeof read === 'string'
      ? { name: rc.address, region, unreadable: read }
      : { name: rc.address, region, config: read });
  }
  return scan;
}
