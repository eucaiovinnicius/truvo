import { execFileSync } from 'node:child_process';

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

console.log(JSON.stringify({
  version: process.env.RELEASE_VERSION ?? process.env.npm_package_version ?? '0.0.0',
  commit: process.env.RELEASE_COMMIT ?? process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']),
  branch: process.env.GITHUB_REF_NAME ?? git(['rev-parse', '--abbrev-ref', 'HEAD']),
  generatedAt: new Date().toISOString(),
}, null, 2));
