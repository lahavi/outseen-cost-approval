# AWS cost approval for Claude

A Claude plugin that puts a cost check in front of AWS launches. When Claude is about to create AWS resources that may cost more than your monthly limit, it stops, shows the estimate and asks you first. It can also price an AWS CLI command, a Terraform plan or a CloudFormation template on request.

Made by [Outseen](https://outseen.com/?utm_source=claude-plugin).

## Install

In Claude Code (2.1.275 or later):

```
/plugin install outseen-cost-approval --marketplace lahavi/outseen-cost-approval
```

Or add the marketplace once with `/plugin marketplace add lahavi/outseen-cost-approval`, then install `outseen-cost-approval@outseen`. In the desktop app's Code tab, add the marketplace the same way, then click **+** next to the prompt box, choose **Add plugins** and pick **AWS cost approval**. You need Node.js 20 or later.

## What it does

**The cost check (Claude Code and Cowork).** Before Claude runs a shell command, the plugin looks for AWS launches in it.

- `aws ec2 run-instances`, `aws rds create-db-instance` and the other commands listed below are priced. If the high end of the monthly estimate is over your limit, you are asked before the command runs:

  > AWS cost check. This would launch r6g.4xlarge × 2, 20GB gp3 root volume in eu-west-1: about $1,255–$1,519/month at on-demand list prices (your limit is $100/month). Not included: data transfer, additional EBS volumes, …

- `terraform apply`, `tofu apply`, `terragrunt apply`, `cdk deploy`, `pulumi up`, `sam deploy` and `aws cloudformation deploy` can't be priced from the command, so you are asked, and Claude is pointed at the estimate skill. If an estimate was made in the same folder in the last 30 minutes and came in under your limit, you are not asked again.
- Launches under your limit, and every other command, run as usual.

The check only ever adds a question. It never approves a command on your behalf and never changes your permission settings. If anything goes wrong inside it, it steps aside and the command proceeds through Claude's normal permission flow.

**The estimate skill (all Claude products).** Ask "what will this cost?" about a command, a Terraform change or a template. Claude runs the bundled estimator and shows a table with a monthly range per resource, what is not included, and a total.

## What it prices

| Resource | AWS CLI | Terraform | CloudFormation |
| --- | --- | --- | --- |
| EC2 instances | `ec2 run-instances` | `aws_instance` | `AWS::EC2::Instance` |
| RDS and Aurora instances | `rds create-db-instance` | `aws_db_instance`, `aws_rds_cluster_instance` | `AWS::RDS::DBInstance` |
| Aurora Serverless | `rds create-db-cluster` | `aws_rds_cluster` | `AWS::RDS::DBCluster` |
| EBS volumes | `ec2 create-volume` | `aws_ebs_volume` | `AWS::EC2::Volume` |
| NAT gateways | `ec2 create-nat-gateway` | `aws_nat_gateway` | `AWS::EC2::NatGateway` |
| ElastiCache | `elasticache create-cache-cluster`, `create-replication-group` | `aws_elasticache_cluster`, `aws_elasticache_replication_group` | `AWS::ElastiCache::CacheCluster`, `ReplicationGroup` |
| Redshift | `redshift create-cluster` | `aws_redshift_cluster` | `AWS::Redshift::Cluster` |
| EKS | `eks create-cluster`, `create-nodegroup` | `aws_eks_cluster`, `aws_eks_node_group` | `AWS::EKS::Cluster`, `Nodegroup` |
| SageMaker notebooks | `sagemaker create-notebook-instance` | `aws_sagemaker_notebook_instance` | `AWS::SageMaker::NotebookInstance` |
| S3 buckets | `s3 mb`, `s3api create-bucket` | `aws_s3_bucket` | `AWS::S3::Bucket` |

Anything else is listed as "not priced" and left out of totals. Nothing is guessed.

## What the estimates are, and are not

- They are AWS **on-demand list prices** for the region, as a range. The range is narrow when today's price list is available and wider when the plugin falls back to its built-in tables.
- They leave out data transfer, Savings Plans, Reserved Instances, negotiated discounts, Spot discounts, and operating-system licences (EC2 is priced as Linux). Each estimate lists what it leaves out.
- Usage-based resources (S3, NAT gateway traffic, Aurora Serverless) use a stated assumption.
- The plugin only sees launches that go through Claude on your machine. It is a check on what Claude does, not a spend cap on your AWS account.

## Settings

Set when you enable the plugin, or later in `/config`:

| Setting | Default | What it does |
| --- | --- | --- |
| Monthly limit (USD) | 100 | You are asked before a launch whose monthly estimate may exceed this. |
| Default AWS region | us-east-1 | Used when a command or template doesn't name a region. `AWS_REGION` in the environment takes priority. |
| Ask when the cost can't be read | on | Also ask before `terraform apply` and other launches that can't be priced from the command. |

## Everything this plugin runs, sends and fetches

- **Runs:** `node dist/hook.cjs` before each Bash command (a PreToolUse hook; it reads the command text and exits), and `node dist/cli.cjs` when the skill estimates something. Both are bundles of the TypeScript in `src/`, built by `npm run build`. Node.js 20 or later must be installed.
- **Fetches:** one public JSON file of AWS list prices per region, at most once a day per region, from `https://lahavi.github.io/outseen-cost-approval/prices/v1/<region>.json`. The request contains nothing but the region name in the URL. If the download fails, built-in price tables are used instead.
- **Sends:** nothing. No commands, resource details, account identifiers, file contents or usage data leave your machine.
- **Reads:** the text of Bash commands Claude is about to run; files you ask it to estimate; the `AWS_REGION` and `AWS_DEFAULT_REGION` environment variables. It never reads AWS credentials and never calls AWS.
- **Writes:** the cached price files and the result of the last estimate (folder, totals and time), in the plugin's data folder.

See [PRIVACY.md](PRIVACY.md).

## Where the prices come from

A scheduled GitHub Action in this repository ([prices.yml](.github/workflows/prices.yml)) downloads AWS's public price lists once a day, keeps the on-demand prices for the resource types above, and publishes one file per region with GitHub Pages. It uses no AWS account or credentials. The built-in fallback tables in `src/engine/built-in-prices.ts` are us-east-1 prices from the same source.

## Approvals for a whole team

This plugin covers what Claude launches on your machine. [Outseen](https://outseen.com/?utm_source=claude-plugin) covers every launch in your AWS accounts, however it was made: it reads CloudTrail, prices each new resource minutes after launch, and sends the costly ones to an approver in Jira, Slack or email.

## Development

```bash
npm install
npm test          # unit tests (Node's test runner)
npm run typecheck
npm run build     # bundles dist/ and regenerates the skill's price reference
node scripts/build-prices.ts --regions us-east-1 --out .prices-work/out   # build price files locally
claude plugin validate . --strict
claude --plugin-dir .                                                      # try it in Claude Code
```

`dist/` is committed so the plugin needs no install step. CI fails if it is out of date.

The pricing core in `src/engine/` is extracted from Outseen's own cost engine. If you change a price rule in one, change it in the other.

## Licence

[Apache-2.0](LICENSE). AWS prices are from AWS's public price lists and are subject to AWS's terms.
