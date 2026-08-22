import { execFileSync } from 'node:child_process';

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const report = JSON.parse(output);
const metadata = Array.isArray(report) ? report[0] : report[Object.keys(report)[0]];
const files = metadata?.files?.map(({ path }) => path) ?? [];
const allowed = (path) =>
  path === 'LICENSE' || path === 'README.md' || path === 'package.json' || path.startsWith('dist/');
const unexpected = files.filter((path) => !allowed(path));
const required = ['dist/cli.js', 'dist/index.js'];
const missing = required.filter((path) => !files.includes(path));

if (unexpected.length || missing.length) {
  console.error(JSON.stringify({ error: 'unexpected package contents', unexpected, missing }));
  process.exitCode = 1;
} else {
  console.log(
    `package contents safe: ${files.length} files (dist, README.md, LICENSE, package.json)`,
  );
}
