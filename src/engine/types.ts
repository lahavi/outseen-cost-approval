// Shared types for the pricing core.

export type ResourceType =
  | 'EC2' | 'RDS' | 'RDS_AURORA' | 'EBS' | 'S3' | 'NAT_GATEWAY'
  | 'ELASTICACHE' | 'REDSHIFT' | 'EKS' | 'SAGEMAKER';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** One resource about to be created, reduced to what its price depends on. */
export type ResourceConfig =
  | { type: 'EC2'; instanceType: string; count?: number; rootVolumeSize?: number; rootVolumeType?: string; market?: 'spot' | 'on-demand' }
  | { type: 'RDS'; instanceClass: string; engine: string; allocatedStorage?: number; multiAZ?: boolean; iops?: number }
  | { type: 'RDS_AURORA'; engine: string; engineMode: string }
  | { type: 'EBS'; size: number; volumeType: string; iops?: number; throughput?: number }
  | { type: 'S3' }
  | { type: 'NAT_GATEWAY' }
  | { type: 'ELASTICACHE'; cacheNodeType: string; numCacheNodes: number }
  | { type: 'REDSHIFT'; nodeType: string; numberOfNodes: number }
  | { type: 'EKS'; kind: 'cluster' }
  | { type: 'EKS'; kind: 'nodegroup'; instanceTypes: string[]; desiredSize: number }
  | { type: 'SAGEMAKER'; instanceType: string; volumeSizeInGB?: number };

/** Where an hourly price came from. */
export type PriceSource =
  | 'aws-price-list'             // today's AWS list price for this region
  | 'built-in'                   // bundled us-east-1 table, exact as of its date
  | 'built-in-regional-estimate' // bundled us-east-1 price × a regional multiplier
  | 'usage-assumption';          // no fixed price; an assumed amount of usage

export interface CostEstimate {
  resourceType: ResourceType;
  /** Short description, e.g. "r6g.4xlarge × 1, 20GB gp3 root volume". */
  summary: string;
  monthly: number;
  monthlyLow: number;
  monthlyHigh: number;
  confidence: Confidence;
  priceSource: PriceSource;
  breakdown: Record<string, number>;
  /** Cost components the estimate leaves out. */
  excludes: string[];
}

/** A resource that could not be priced. Never guessed. */
export interface Unpriced {
  unpriced: true;
  resourceType?: ResourceType;
  summary: string;
  reason: string;
}

export type Priced = CostEstimate | Unpriced;

export function isUnpriced(p: Priced): p is Unpriced {
  return (p as Unpriced).unpriced === true;
}

/**
 * Daily list prices for one region, built from AWS's public price lists.
 * Hourly USD unless noted.
 */
export interface PriceBook {
  version: 1;
  region: string;
  /** AWS's publication date for these prices (ISO). */
  asOf: string;
  ec2: Record<string, number>;                    // on-demand Linux, shared tenancy
  rds: Record<string, Record<string, number>>;    // class → engine → Single-AZ hourly
  elasticache: Record<string, number>;
  redshift: Record<string, number>;
  sagemaker: Record<string, number>;              // notebook instances
  ebs?: Record<string, number>;                   // USD per GB-month by volume type
  nat?: { hourly: number; perGb: number };
}
