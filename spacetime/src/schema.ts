// Table handles + the module schema (INTERFACES.md §2, plus Role 1's dev_config and the
// private recluster schedule).

import { schema, table, t } from 'spacetimedb/server';
import { TABLE_COLUMNS as C } from './columns.ts';

const anomaly_event = table({ name: 'anomaly_event', public: true }, C.anomaly_event(t));
const track = table({ name: 'track', public: true }, C.track(t));
const campaign = table({ name: 'campaign', public: true }, C.campaign(t));
const agent_trace = table({ name: 'agent_trace', public: true }, C.agent_trace(t));
const prediction = table({ name: 'prediction', public: true }, C.prediction(t));
const alert = table({ name: 'alert', public: true }, C.alert(t));
const sim_truth = table({ name: 'sim_truth', public: true }, C.sim_truth(t));
const dev_config = table({ name: 'dev_config', public: true }, C.dev_config(t));
const recluster_schedule = table(
  { name: 'recluster_schedule' },
  { scheduled_id: t.u64().primaryKey().autoInc(), scheduled_at: t.scheduleAt() },
);

const spacetimedb = schema({
  anomaly_event, track, campaign, agent_trace, prediction, alert, sim_truth, dev_config, recluster_schedule,
});
export default spacetimedb;
export { recluster_schedule };
