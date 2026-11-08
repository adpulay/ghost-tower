// Client bindings for the Ghost Tower module, hand-written in the same shape that
// `spacetime generate --lang typescript` produces, built from the same column/param
// definitions as the module (../src/columns.ts) so they cannot drift.
//
// If you have the CLI, you can regenerate the official ones instead:
//   spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path spacetime
import {
  DbConnectionBuilder as __DbConnectionBuilder,
  DbConnectionImpl as __DbConnectionImpl,
  SubscriptionBuilderImpl as __SubscriptionBuilderImpl,
  convertToAccessorMap as __convertToAccessorMap,
  makeQueryBuilder as __makeQueryBuilder,
  procedures as __procedures,
  reducerSchema as __reducerSchema,
  reducers as __reducers,
  schema as __schema,
  t as __t,
  table as __table,
  type DbConnectionConfig as __DbConnectionConfig,
  type EventContextInterface as __EventContextInterface,
  type QueryBuilder as __QueryBuilder,
  type RemoteModule as __RemoteModule,
} from 'spacetimedb';
import { REDUCER_PARAMS as R, TABLE_COLUMNS as C } from '../src/columns.ts';

const tablesSchema = __schema({
  anomaly_event: __table({ name: 'anomaly_event' }, C.anomaly_event(__t)),
  track: __table({ name: 'track' }, C.track(__t)),
  campaign: __table({ name: 'campaign' }, C.campaign(__t)),
  agent_trace: __table({ name: 'agent_trace' }, C.agent_trace(__t)),
  prediction: __table({ name: 'prediction' }, C.prediction(__t)),
  alert: __table({ name: 'alert' }, C.alert(__t)),
  sim_truth: __table({ name: 'sim_truth' }, C.sim_truth(__t)),
  dev_config: __table({ name: 'dev_config' }, C.dev_config(__t)),
});

const reducersSchema = __reducers(
  __reducerSchema('report_anomaly', R.report_anomaly(__t)),
  __reducerSchema('agent_write_trace', R.agent_write_trace(__t)),
  __reducerSchema('agent_set_prediction', R.agent_set_prediction(__t)),
  __reducerSchema('agent_link_campaign', R.agent_link_campaign(__t)),
  __reducerSchema('agent_record_alert', R.agent_record_alert(__t)),
  __reducerSchema('sim_write_truth', R.sim_write_truth(__t)),
  __reducerSchema('dev_set_fusion_weights', R.dev_set_fusion_weights(__t)),
  __reducerSchema('reset_world', {}),
);

const proceduresSchema = __procedures();

const REMOTE_MODULE = {
  versionInfo: { cliVersion: '2.14.1' as const },
  tables: tablesSchema.schemaType.tables,
  reducers: reducersSchema.reducersType.reducers,
  ...proceduresSchema,
} satisfies __RemoteModule<typeof tablesSchema.schemaType, typeof reducersSchema.reducersType, typeof proceduresSchema>;

export const tables: __QueryBuilder<typeof tablesSchema.schemaType> = __makeQueryBuilder(tablesSchema.schemaType);
export const reducers = __convertToAccessorMap(reducersSchema.reducersType.reducers);
export type EventContext = __EventContextInterface<typeof REMOTE_MODULE>;

export class SubscriptionBuilder extends __SubscriptionBuilderImpl<typeof REMOTE_MODULE> {}
export class DbConnectionBuilder extends __DbConnectionBuilder<DbConnection> {}
export class DbConnection extends __DbConnectionImpl<typeof REMOTE_MODULE> {
  static builder = (): DbConnectionBuilder =>
    new DbConnectionBuilder(REMOTE_MODULE, (config: __DbConnectionConfig<typeof REMOTE_MODULE>) => new DbConnection(config));
  override subscriptionBuilder = (): SubscriptionBuilder => new SubscriptionBuilder(this);
}

/** Connection settings shared by sim and eval. Override with env vars. */
// (globalThis.process guard: these bindings also load in the browser, where there is no process.)
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
export const SPACETIME_HOST = env.SPACETIME_HOST ?? 'ws://localhost:3000';
export const SPACETIME_DB = env.SPACETIME_DB ?? 'ghost-tower';

/** Connect and resolve once the socket is up. */
export function connect(opts: { host?: string; db?: string } = {}): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(opts.host ?? SPACETIME_HOST)
      .withDatabaseName(opts.db ?? SPACETIME_DB)
      .onConnect(conn => resolve(conn))
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
}
