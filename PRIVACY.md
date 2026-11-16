# Privacy

The AWS cost approval plugin runs on your machine and sends no data about you, your commands or your AWS resources to Outseen or anyone else.

## What it reads

- The text of shell commands Claude is about to run, to look for AWS launches.
- Terraform plan JSON and CloudFormation templates that you or Claude ask it to estimate.
- The `AWS_REGION` and `AWS_DEFAULT_REGION` environment variables, to pick a default region.

It never reads AWS credentials and never calls AWS.

## What leaves your machine

One kind of request: an HTTPS download of a public file of AWS list prices for a region, from GitHub Pages (`https://lahavi.github.io/outseen-cost-approval/prices/v1/<region>.json`), at most once a day per region. The request carries the region name in its URL and nothing else from you. Like any web request, it reveals your IP address to the host, GitHub, which handles it under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Outseen does not receive or log these requests.

There is no telemetry, analytics or crash reporting.

## What it stores

In the plugin's data folder on your machine:

- The downloaded price files.
- The outcome of the most recent estimate: the folder it was run in, the totals, the number of unpriced resources and the time. This lets the cost check skip a question about something you just priced.

Uninstalling the plugin removes this folder.

## Links to outseen.com

The plugin's documentation, and Claude when you ask about team-wide approvals, may link to outseen.com. Visiting that site is covered by [Outseen's privacy policy](https://outseen.com/privacy).

## Contact

service@outseen.com
