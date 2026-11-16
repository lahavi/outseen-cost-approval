import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAwsCommand, scanCommandLine, splitCommands } from '../src/inputs/aws-cli.ts';
import { parseTemplate, scanCloudFormation } from '../src/inputs/cloudformation.ts';
import { scanTerraformPlan } from '../src/inputs/terraform-plan.ts';

const one = (line: string, region = 'us-east-1') => {
  const scan = scanCommandLine(line, region);
  assert.equal(scan.resources.length, 1, JSON.stringify(scan));
  return scan.resources[0];
};

// ─── Shell and aws parsing ───────────────────────────────────────────────────

test('splitCommands handles quotes, chains, pipes and line continuations', () => {
  assert.deepEqual(splitCommands(`cd infra && aws s3 mb "s3://my bucket"; echo 'a && b' | cat`), [
    ['cd', 'infra'], ['aws', 's3', 'mb', 's3://my bucket'], ['echo', 'a && b'], ['cat'],
  ]);
  assert.deepEqual(splitCommands('aws ec2 run-instances \\\n  --instance-type m5.large'), [['aws', 'ec2', 'run-instances', '--instance-type', 'm5.large']]);
});

test('parseAwsCommand finds the service, operation, options and region', () => {
  const c = parseAwsCommand(['AWS_REGION=eu-west-2', 'aws', '--profile', 'prod', '--no-cli-pager', 'rds', 'create-db-instance', '--engine=postgres', '--multi-az', '--db-instance-class', 'db.m5.large'])!;
  assert.equal(c.service, 'rds');
  assert.equal(c.operation, 'create-db-instance');
  assert.equal(c.region, 'eu-west-2');
  assert.deepEqual(c.options.get('--engine'), ['postgres']);
  assert.deepEqual(c.options.get('--multi-az'), []);
  assert.equal(parseAwsCommand(['echo', 'aws', 'ec2', 'run-instances']), null);
  assert.equal(parseAwsCommand(['/usr/local/bin/aws', '--region', 'us-west-2', 'ec2', 'describe-instances'])!.region, 'us-west-2');
});

// ─── Every launch command ────────────────────────────────────────────────────

test('ec2 run-instances: type, count (max of min:max), root volume, Spot, region', () => {
  const r = one(`aws ec2 run-instances --image-id ami-1 --instance-type r6g.4xlarge --count 2:5 --region eu-west-1 --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":200,"VolumeType":"gp3"}}]' --instance-market-options MarketType=spot`);
  assert.equal(r.region, 'eu-west-1');
  assert.deepEqual(r.config, { type: 'EC2', instanceType: 'r6g.4xlarge', count: 5, rootVolumeSize: 200, rootVolumeType: 'gp3', market: 'spot' });
  const shorthand = one('aws ec2 run-instances --instance-type m5.large --block-device-mappings DeviceName=/dev/sda1,Ebs={VolumeSize=50,VolumeType=gp2}');
  assert.deepEqual(shorthand.config, { type: 'EC2', instanceType: 'm5.large', count: 1, rootVolumeSize: 50, rootVolumeType: 'gp2', market: undefined });
});

test('ec2 run-instances without a readable type is reported, not guessed', () => {
  assert.match(one('aws ec2 run-instances --launch-template LaunchTemplateName=web').unreadable!, /launch template/);
  assert.match(one('aws ec2 run-instances --instance-type $TYPE').unreadable!, /variable/);
  assert.match(one('aws ec2 run-instances --cli-input-json file://launch.json').unreadable!, /input file/);
});

test('the other launch commands', () => {
  assert.deepEqual(one('aws ec2 create-volume --size 500 --volume-type gp3 --iops 6000 --availability-zone us-east-1a').config,
    { type: 'EBS', size: 500, volumeType: 'gp3', iops: 6000, throughput: undefined });
  assert.match(one('aws ec2 create-volume --snapshot-id snap-1 --availability-zone us-east-1a').unreadable!, /snapshot/);
  assert.deepEqual(one('aws ec2 create-nat-gateway --subnet-id subnet-1 --allocation-id eipalloc-1').config, { type: 'NAT_GATEWAY' });
  assert.deepEqual(one('aws rds create-db-instance --db-instance-identifier db1 --db-instance-class db.r6g.xlarge --engine postgres --allocated-storage 200 --multi-az').config,
    { type: 'RDS', instanceClass: 'db.r6g.xlarge', engine: 'postgres', allocatedStorage: 200, multiAZ: true, iops: undefined });
  assert.deepEqual(one('aws rds create-db-cluster --db-cluster-identifier c --engine aurora-postgresql --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=8').config,
    { type: 'RDS_AURORA', engine: 'aurora-postgresql', engineMode: 'serverless' });
  assert.match(one('aws rds create-db-cluster --db-cluster-identifier c --engine aurora-mysql').unreadable!, /no hourly charge/);
  assert.deepEqual(one('aws elasticache create-cache-cluster --cache-cluster-id c --cache-node-type cache.r6g.large --num-cache-nodes 3 --engine redis').config,
    { type: 'ELASTICACHE', cacheNodeType: 'cache.r6g.large', numCacheNodes: 3 });
  assert.deepEqual(one('aws elasticache create-replication-group --replication-group-id g --cache-node-type cache.m5.large --num-node-groups 2 --replicas-per-node-group 2').config,
    { type: 'ELASTICACHE', cacheNodeType: 'cache.m5.large', numCacheNodes: 6 });
  assert.deepEqual(one('aws redshift create-cluster --cluster-identifier c --node-type ra3.4xlarge --number-of-nodes 4').config,
    { type: 'REDSHIFT', nodeType: 'ra3.4xlarge', numberOfNodes: 4 });
  assert.deepEqual(one('aws eks create-cluster --name prod --role-arn arn:aws:iam::1:role/x').config, { type: 'EKS', kind: 'cluster' });
  assert.deepEqual(one('aws eks create-nodegroup --cluster-name prod --nodegroup-name ng --instance-types m5.xlarge m5.2xlarge --scaling-config minSize=2,maxSize=10,desiredSize=4').config,
    { type: 'EKS', kind: 'nodegroup', instanceTypes: ['m5.xlarge', 'm5.2xlarge'], desiredSize: 4 });
  assert.deepEqual(one('aws sagemaker create-notebook-instance --notebook-instance-name n --instance-type ml.g4dn.xlarge --volume-size-in-gb 100').config,
    { type: 'SAGEMAKER', instanceType: 'ml.g4dn.xlarge', volumeSizeInGB: 100 });
  assert.deepEqual(one('aws s3 mb s3://bucket').config, { type: 'S3' });
  assert.deepEqual(one('aws s3api create-bucket --bucket b').config, { type: 'S3' });
});

test('several launches in one line, each with its own region', () => {
  const scan = scanCommandLine('aws ec2 run-instances --instance-type m5.large --region eu-west-1 && AWS_REGION=ap-south-1 aws ec2 create-nat-gateway --subnet-id s; aws ec2 describe-instances', 'us-east-1');
  assert.deepEqual(scan.resources.map((r) => [r.name, r.region]), [['aws ec2 run-instances', 'eu-west-1'], ['aws ec2 create-nat-gateway', 'ap-south-1']]);
});

test('things that launch nothing are ignored', () => {
  for (const line of [
    'aws ec2 describe-instances', 'aws ec2 run-instances --instance-type m5.large --dry-run', 'aws s3 ls', 'aws ec2 stop-instances --instance-ids i-1',
    'echo "aws ec2 run-instances --instance-type m5.large"', 'terraform plan -out tfplan', 'terraform apply -destroy', 'npm test', 'cdk synth', 'cdk diff',
  ]) {
    const scan = scanCommandLine(line, 'us-east-1');
    assert.deepEqual([scan.resources.length, scan.deployments.length], [0, 0], line);
  }
});

test('deployments whose resources are not in the command are named', () => {
  const names = (line: string) => scanCommandLine(line, 'us-east-1').deployments;
  assert.deepEqual(names('cd infra && terraform apply -auto-approve'), ['terraform apply']);
  assert.deepEqual(names('tofu apply tfplan'), ['tofu apply']);
  assert.deepEqual(names('terragrunt run-all apply'), ['terragrunt apply']);
  assert.deepEqual(names('npx cdk deploy --all'), ['cdk deploy']);
  assert.deepEqual(names('sudo aws cloudformation deploy --template-file t.yaml --stack-name s'), ['aws cloudformation deploy']);
  assert.deepEqual(names('cdk deploy --all'), ['cdk deploy']);
  assert.deepEqual(names('pulumi up --yes'), ['pulumi up']);
  assert.deepEqual(names('sam deploy --guided'), ['sam deploy']);
  assert.deepEqual(names('aws cloudformation deploy --template-file t.yaml --stack-name s'), ['aws cloudformation deploy']);
  assert.deepEqual(names('aws cloudformation create-stack --stack-name s --template-body file://t.yaml'), ['aws cloudformation create-stack']);
});

// ─── Terraform ───────────────────────────────────────────────────────────────

const change = (type: string, after: object, actions = ['create'], name = 'x') =>
  ({ address: `${type}.${name}`, mode: 'managed', type, change: { actions, after } });

test('terraform plan: every covered type, creates only, region from the provider', () => {
  const plan = {
    configuration: { provider_config: { aws: { expressions: { region: { constant_value: 'eu-central-1' } } } } },
    resource_changes: [
      change('aws_instance', { instance_type: 'm5.large', root_block_device: [{ volume_size: 80, volume_type: 'gp3' }] }),
      change('aws_db_instance', { instance_class: 'db.m5.large', engine: 'mysql', allocated_storage: 100, multi_az: true }),
      change('aws_rds_cluster_instance', { instance_class: 'db.r6g.large', engine: 'aurora-postgresql' }),
      change('aws_rds_cluster_instance', { instance_class: 'db.serverless', engine: 'aurora-postgresql' }, ['create'], 'sv2'),
      change('aws_rds_cluster', { engine: 'aurora-postgresql' }),
      change('aws_ebs_volume', { size: 500, type: 'io1', iops: 3000 }),
      change('aws_nat_gateway', {}),
      change('aws_elasticache_cluster', { node_type: 'cache.t3.medium', num_cache_nodes: 2 }),
      change('aws_elasticache_replication_group', { node_type: 'cache.r6g.large', num_cache_clusters: 3 }),
      change('aws_redshift_cluster', { node_type: 'ra3.xlplus', number_of_nodes: 2 }),
      change('aws_eks_cluster', {}),
      change('aws_eks_node_group', { instance_types: ['m5.large'], scaling_config: [{ desired_size: 3 }] }),
      change('aws_sagemaker_notebook_instance', { instance_type: 'ml.t3.medium', volume_size: 20 }),
      change('aws_s3_bucket', {}),
      change('aws_instance', { instance_type: 'x1e.32xlarge' }, ['delete'], 'old'),
      change('aws_instance', { instance_type: 'x1e.32xlarge' }, ['update'], 'changed'),
      change('aws_instance', {}, ['create'], 'unknown'),
      change('aws_iam_role', {}),
      change('aws_lb', {}),
      change('aws_lb', {}, ['create'], 'second'),
      change('google_compute_instance', { machine_type: 'n1' }),
      { address: 'data.aws_ami.x', mode: 'data', type: 'aws_ami', change: { actions: ['read'], after: {} } },
    ],
  };
  const scan = scanTerraformPlan(plan, 'us-east-1');
  assert.ok(scan.resources.every((r) => r.region === 'eu-central-1'));
  const byName = Object.fromEntries(scan.resources.map((r) => [r.name, r]));
  assert.equal(scan.resources.length, 15);
  assert.deepEqual(byName['aws_instance.x'].config, { type: 'EC2', instanceType: 'm5.large', rootVolumeSize: 80, rootVolumeType: 'gp3', market: undefined });
  assert.deepEqual(byName['aws_db_instance.x'].config, { type: 'RDS', instanceClass: 'db.m5.large', engine: 'mysql', allocatedStorage: 100, multiAZ: true, iops: undefined });
  assert.deepEqual(byName['aws_rds_cluster_instance.x'].config, { type: 'RDS', instanceClass: 'db.r6g.large', engine: 'aurora-postgresql' });
  assert.equal(byName['aws_rds_cluster_instance.sv2'].config!.type, 'RDS_AURORA');
  assert.match(byName['aws_rds_cluster.x'].unreadable!, /no hourly charge/);
  assert.deepEqual(byName['aws_ebs_volume.x'].config, { type: 'EBS', size: 500, volumeType: 'io1', iops: 3000, throughput: undefined });
  assert.deepEqual(byName['aws_elasticache_replication_group.x'].config, { type: 'ELASTICACHE', cacheNodeType: 'cache.r6g.large', numCacheNodes: 3 });
  assert.deepEqual(byName['aws_eks_node_group.x'].config, { type: 'EKS', kind: 'nodegroup', instanceTypes: ['m5.large'], desiredSize: 3 });
  assert.deepEqual(byName['aws_sagemaker_notebook_instance.x'].config, { type: 'SAGEMAKER', instanceType: 'ml.t3.medium', volumeSizeInGB: 20 });
  assert.match(byName['aws_instance.unknown'].unreadable!, /not known until apply/);
  assert.equal(byName['aws_instance.old'], undefined);
  assert.equal(byName['aws_instance.changed'], undefined);
  assert.deepEqual(scan.notCovered, { aws_iam_role: 1, aws_lb: 2 });
});

// ─── CloudFormation ──────────────────────────────────────────────────────────

test('cloudformation YAML: literals, parameter defaults, and computed values reported', () => {
  const template = parseTemplate(`
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  DbClass: { Type: String, Default: db.r6g.large }
  WebType: { Type: String }
Resources:
  Web:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: m5.xlarge
      ImageId: !Ref AmiParam
      BlockDeviceMappings:
        - DeviceName: /dev/xvda
          Ebs: { VolumeSize: 100, VolumeType: gp3 }
  Worker:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: !Ref WebType
  Db:
    Type: AWS::RDS::DBInstance
    Properties:
      DBInstanceClass: !Ref DbClass
      Engine: postgres
      AllocatedStorage: '200'
      MultiAZ: true
  Cache:
    Type: AWS::ElastiCache::CacheCluster
    Properties: { CacheNodeType: cache.t3.medium, NumCacheNodes: 2, Engine: redis }
  Nat:
    Type: AWS::EC2::NatGateway
    Properties: { SubnetId: !Ref Subnet, AllocationId: !GetAtt Eip.AllocationId }
  Nodes:
    Type: AWS::EKS::Nodegroup
    Properties:
      InstanceTypes: [m5.large]
      ScalingConfig: { DesiredSize: 3 }
  Topic:
    Type: AWS::SNS::Topic
  Name:
    Type: AWS::SSM::Parameter
    Properties: { Value: !Sub '\${AWS::StackName}-x' }
`);
  const scan = scanCloudFormation(template, 'eu-west-1');
  const byName = Object.fromEntries(scan.resources.map((r) => [r.name, r]));
  assert.deepEqual(byName.Web.config, { type: 'EC2', instanceType: 'm5.xlarge', rootVolumeSize: 100, rootVolumeType: 'gp3' });
  assert.match(byName.Worker.unreadable!, /parameter without a default/);
  assert.deepEqual(byName.Db.config, { type: 'RDS', instanceClass: 'db.r6g.large', engine: 'postgres', allocatedStorage: 200, multiAZ: true, iops: undefined });
  assert.deepEqual(byName.Cache.config, { type: 'ELASTICACHE', cacheNodeType: 'cache.t3.medium', numCacheNodes: 2 });
  assert.deepEqual(byName.Nat.config, { type: 'NAT_GATEWAY' });
  assert.deepEqual(byName.Nodes.config, { type: 'EKS', kind: 'nodegroup', instanceTypes: ['m5.large'], desiredSize: 3 });
  assert.deepEqual(scan.notCovered, { 'AWS::SNS::Topic': 1, 'AWS::SSM::Parameter': 1 });
  assert.ok(scan.resources.every((r) => r.region === 'eu-west-1'));
});

test('cloudformation JSON: the remaining types', () => {
  const template = parseTemplate(JSON.stringify({
    Resources: {
      Vol: { Type: 'AWS::EC2::Volume', Properties: { Size: 500, VolumeType: 'gp3', Iops: 6000 } },
      SnapVol: { Type: 'AWS::EC2::Volume', Properties: { SnapshotId: 'snap-1' } },
      Aurora: { Type: 'AWS::RDS::DBCluster', Properties: { Engine: 'aurora-postgresql', ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 } } },
      Dw: { Type: 'AWS::Redshift::Cluster', Properties: { NodeType: 'ra3.4xlarge', NumberOfNodes: 2 } },
      Group: { Type: 'AWS::ElastiCache::ReplicationGroup', Properties: { CacheNodeType: 'cache.r6g.large', NumCacheClusters: 2 } },
      K8s: { Type: 'AWS::EKS::Cluster', Properties: {} },
      Nb: { Type: 'AWS::SageMaker::NotebookInstance', Properties: { InstanceType: 'ml.t3.medium' } },
      Bucket: { Type: 'AWS::S3::Bucket' },
    },
  }));
  const byName = Object.fromEntries(scanCloudFormation(template, 'us-east-1').resources.map((r) => [r.name, r]));
  assert.deepEqual(byName.Vol.config, { type: 'EBS', size: 500, volumeType: 'gp3', iops: 6000, throughput: undefined });
  assert.match(byName.SnapVol.unreadable!, /snapshot/);
  assert.equal(byName.Aurora.config!.type, 'RDS_AURORA');
  assert.deepEqual(byName.Dw.config, { type: 'REDSHIFT', nodeType: 'ra3.4xlarge', numberOfNodes: 2 });
  assert.deepEqual(byName.Group.config, { type: 'ELASTICACHE', cacheNodeType: 'cache.r6g.large', numCacheNodes: 2 });
  assert.deepEqual(byName.K8s.config, { type: 'EKS', kind: 'cluster' });
  assert.deepEqual(byName.Nb.config, { type: 'SAGEMAKER', instanceType: 'ml.t3.medium', volumeSizeInGB: undefined });
  assert.deepEqual(byName.Bucket.config, { type: 'S3' });
});
