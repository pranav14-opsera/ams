import { Kafka, type Producer } from "kafkajs";

export const DEPLOYMENT_EVENT_TYPES = [
  "start",
  "canary-begin",
  "canary-pass",
  "canary-fail",
  "promote",
  "rollback",
] as const;
export type DeploymentEventType = (typeof DEPLOYMENT_EVENT_TYPES)[number];

export interface DeploymentEvent {
  eventType: DeploymentEventType;
  service: string;
  version: string;
  environment: string;
  actor: string;
  timestamp: string;
  metadata?: Record<string, string>;
}

export function buildDeploymentEvent(input: {
  eventType: DeploymentEventType;
  service: string;
  version: string;
  environment: string;
  actor: string;
  metadata?: Record<string, string>;
  now?: () => Date;
}): DeploymentEvent {
  if (!DEPLOYMENT_EVENT_TYPES.includes(input.eventType)) {
    throw new Error(`Unknown deployment event type: ${input.eventType}`);
  }
  if (!input.service || !input.version || !input.environment || !input.actor) {
    throw new Error("service, version, environment, and actor are all required");
  }
  const now = input.now ?? (() => new Date());
  return {
    eventType: input.eventType,
    service: input.service,
    version: input.version,
    environment: input.environment,
    actor: input.actor,
    timestamp: now().toISOString(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

// Partitioned by service name (not a random key) so every event for one
// service's deployment history lands in the same partition, in order —
// matching the tenant_id-keyed ordering convention used for the other
// audit-events producers (WO-006).
export async function publishDeploymentEvent(producer: Producer, event: DeploymentEvent): Promise<void> {
  await producer.send({
    topic: "audit-events",
    messages: [{ key: event.service, value: JSON.stringify(event) }],
  });
}

async function main() {
  const eventType = process.env.EVENT_TYPE as DeploymentEventType;
  const service = process.env.SERVICE ?? "";
  const version = process.env.VERSION ?? "";
  const environment = process.env.TARGET_ENVIRONMENT ?? "";
  const actor = process.env.DEPLOY_ACTOR ?? "forge-pipeline";
  const brokers = (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean);

  if (brokers.length === 0) {
    throw new Error("KAFKA_BROKERS is required — no project-specific MSK connector exists in this environment yet (see .forge/pipeline.yaml deploy-audit-log step)");
  }

  const event = buildDeploymentEvent({ eventType, service, version, environment, actor });

  const kafka = new Kafka({ clientId: "deploy-audit-publisher", brokers });
  const producer = kafka.producer();
  await producer.connect();
  try {
    await publishDeploymentEvent(producer, event);
    console.log(`Published ${event.eventType} event for ${event.service}@${event.version} (${event.environment})`);
  } finally {
    await producer.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
