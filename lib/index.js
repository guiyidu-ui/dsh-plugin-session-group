// dsh-plugin-session-group — host half (intentionally empty).
//
// Pure client-side UI plugin: no host routes, no services. The whole feature
// lives in lib/client.js (browser bundle), which shadows the built-in
// `sidebar.workspaces` slot with a cwd/project-grouped session tree.

const name = "session-group";
const inject = [];

function apply() {}

export { apply, inject, name };
