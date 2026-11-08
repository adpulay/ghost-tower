// Lets the real module run in-process under plain Node via spacetimedb/server/test-utils.
//
// The SDK imports the host ABI as `spacetime:sys@2.x`, which only exists inside SpacetimeDB.
// The SDK's own vitest plugin swaps in a stub for unit tests; this is the same stub as a Node
// resolve hook, so `node --import ./spacetime/test/sys_stub.ts` (or importing this file
// before the harness) is enough. Used by the tests, `sim run --local` and the eval.
import { registerHooks } from 'node:module';

const UNSUPPORTED = [
  'identity', 'get_jwt_payload', 'table_id_from_name', 'index_id_from_name', 'datastore_table_row_count',
  'datastore_table_scan_bsatn', 'datastore_insert_bsatn', 'datastore_delete_all_by_eq_bsatn',
  'datastore_index_scan_point_bsatn', 'datastore_index_scan_range_bsatn',
  'datastore_delete_by_index_scan_point_bsatn', 'datastore_delete_by_index_scan_range_bsatn',
  'datastore_update_bsatn', 'datastore_clear', 'row_iter_bsatn_advance', 'row_iter_bsatn_close',
  'procedure_start_mut_tx', 'procedure_commit_mut_tx', 'procedure_abort_mut_tx', 'procedure_http_request',
  'env_get', 'volatile_nonatomic_schedule_immediate',
];

const SOURCE = [
  `export const moduleHooks = Symbol.for('spacetimedb.moduleHooks');`,
  `const u = n => () => { throw new Error('Unsupported SpacetimeDB host syscall in local harness: ' + n); };`,
  ...UNSUPPORTED.map(n => `export const ${n} = u('${n}');`),
  `export const console_log = () => {};`,
  `export const console_timer_start = () => 0;`,
  `export const console_timer_end = () => {};`,
].join('\n');

const g = globalThis as { __ghostTowerSysStub?: boolean; __ghostTowerConsole?: Console };
/**
 * The SDK's server runtime replaces globalThis.console with one that forwards to the host's
 * log syscall (a no-op here). Call this after importing the module to get Node's back.
 */
export function restoreConsole() {
  if (g.__ghostTowerConsole) globalThis.console = g.__ghostTowerConsole;
}
if (!g.__ghostTowerSysStub) {
  g.__ghostTowerSysStub = true;
  g.__ghostTowerConsole = globalThis.console;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('spacetime:sys@2.')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(SOURCE), format: 'module', shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}
