// D-56 item 2: the one place that touches @github/copilot-sdk. Account data only: never a session,
// never a prompt, never a token. Contract: docs/contracts/internal.md (copilot-account.ts row).

/** The small surface copilot-account.ts uses; tests fake this, not the SDK. */
export interface CopilotAccountClient {
  start(): Promise<void>;
  status(): Promise<{ runtimeVersion: string | null }>;
  quota(): Promise<unknown>;
  stop(): Promise<void>;
}

/**
 * A client over the real SDK. The SDK is loaded with a dynamic import so that a daemon with the
 * account service off never loads it. No gitHubToken is ever passed: the SDK uses the logged-in user.
 */
export function createSdkClient(): CopilotAccountClient {
  type Sdk = typeof import("@github/copilot-sdk");
  type Client = InstanceType<Sdk["CopilotClient"]>;
  let client: Client | null = null;

  const load = async (): Promise<Client> => {
    if (client === null) {
      const sdk = await import("@github/copilot-sdk");
      client = new sdk.CopilotClient();
    }
    return client;
  };

  return {
    async start() {
      await (await load()).start();
    },
    async status() {
      const info = await (await load()).getStatus();
      return { runtimeVersion: typeof info.version === "string" ? info.version : null };
    },
    async quota() {
      return (await load()).rpc.account.getQuota({});
    },
    async stop() {
      if (client !== null) await client.stop();
    },
  };
}
