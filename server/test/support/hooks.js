// TEST-ONLY module resolution: map packages that can't be installed in the sandbox to shims
// or to preinstalled copies. Real installs use package.json dependencies.
const MAP = {
  express: new URL('./shims/express.js', import.meta.url).href,
  cors: new URL('./shims/cors.js', import.meta.url).href,
  ws: 'file:///opt/npm-tools/node_modules/ws/wrapper.mjs',
};
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true };
  return next(specifier, context);
}
