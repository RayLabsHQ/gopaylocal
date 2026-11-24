#!/usr/bin/env bash
# Publishes each package directory given as an argument whose package.json
# version is not on npm yet. Used by .github/workflows/release-sdks.yml.
#
#   DRY_RUN=true   build each package and list the files it would publish;
#                  publish nothing.
#   NPM_REGISTRY   registry to ask whether a version exists
#                  (default https://registry.npmjs.org).
#
# `npm publish` and `npm pack` run the package's `prepack` script, which builds it.
set -euo pipefail

registry="${NPM_REGISTRY:-https://registry.npmjs.org}"
dry_run="${DRY_RUN:-false}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$#" -eq 0 ]; then
  echo "usage: release-sdks.sh <package directory>..." >&2
  exit 2
fi

{
  echo "| Package | Version | Result |"
  echo "|---|---|---|"
} >> "$summary"

for dir in "$@"; do
  name=$(jq -er '.name' "$dir/package.json")
  version=$(jq -er '.version' "$dir/package.json")

  if [ "$(jq -r '.private // false' "$dir/package.json")" = "true" ]; then
    echo "::error::$name is marked private in $dir/package.json and cannot be published."
    exit 1
  fi

  # 200: this version exists. 404: the version, or the whole package, does not.
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$registry/$name/$version" || true)
  case "$status" in
    200)
      echo "$name@$version is already on npm: skipped."
      echo "| \`$name\` | $version | Already on npm, skipped |" >> "$summary"
      continue
      ;;
    404) ;;
    *)
      echo "::error::Could not ask npm whether $name@$version exists (HTTP $status)."
      exit 1
      ;;
  esac

  # npm refuses a prerelease version without an explicit dist-tag.
  tag=latest
  case "$version" in *-*) tag=next ;; esac

  if [ "$dry_run" = "true" ]; then
    echo "Dry run: $name@$version would be published under \"$tag\". Its files:"
    (cd "$dir" && npm pack --dry-run)
    echo "| \`$name\` | $version | Dry run: would be published under \`$tag\` |" >> "$summary"
  else
    echo "Publishing $name@$version under \"$tag\"."
    (cd "$dir" && npm publish --tag "$tag")
    echo "| \`$name\` | $version | Published under \`$tag\` |" >> "$summary"
  fi
done
