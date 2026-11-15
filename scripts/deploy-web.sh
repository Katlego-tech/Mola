#!/usr/bin/env bash
# Builds the frontend against a deployed stack and publishes it to that stack's bucket.
# Usage: scripts/deploy-web.sh dev|demo     (AWS_PROFILE defaults to "default")
set -euo pipefail

env="${1:?usage: scripts/deploy-web.sh dev|demo}"
root="$(cd "$(dirname "$0")/.." && pwd)"
stack="mola-$env"
region="af-south-1"
profile="${AWS_PROFILE:-default}"
aws_() { aws --region "$region" --profile "$profile" "$@"; }

output() {
  aws_ cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
ws_url="$(output WebSocketUrl)"
site="$(output WebsiteUrl)"
bucket="$(output WebBucketName)"
distribution="$(output DistributionId)"
for v in ws_url site bucket distribution; do
  [ -n "${!v}" ] && [ "${!v}" != None ] || { echo "stack $stack has no output for $v" >&2; exit 1; }
done

cd "$root/frontend"
VITE_WS_URL="$ws_url" VITE_APP_URL="$site" npm run build

# Hashed assets never change: cache them for a year. index.html must always be revalidated.
aws_ s3 sync dist "s3://$bucket" --delete --exclude index.html \
  --cache-control "public, max-age=31536000, immutable"
aws_ s3 cp dist/index.html "s3://$bucket/index.html" --cache-control "no-cache"
aws_ cloudfront create-invalidation --distribution-id "$distribution" --paths "/index.html" >/dev/null

echo "Published $site  (screen: $site/screen?office=demo)"
