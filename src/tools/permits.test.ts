import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the args every SendMessageCommand is constructed with so we can
// assert the SQS payload shape (no FIFO-only params on a STANDARD queue).
const sendMessageInputs: Array<Record<string, unknown>> = [];
const sqsSend = vi.fn(async () => ({ MessageId: "test-message-id" }));

vi.mock("@aws-sdk/client-sqs", () => {
  class SendMessageCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
      sendMessageInputs.push(input);
    }
  }
  class SQSClient {
    send = sqsSend;
  }
  return { SQSClient, SendMessageCommand };
});

// IPFS cache lookup should miss so the handler reaches the enqueue path.
vi.mock("../lib/ipfs.ts", () => ({
  fetchFromIpfs: vi.fn(async () => {
    throw new Error("no ipfs in test");
  }),
}));

const { getPropertyPermitsHandler } = await import("./permits.ts");

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("getPropertyPermits SQS enqueue", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sendMessageInputs.length = 0;
    sqsSend.mockClear();
    delete process.env.PERMIT_CACHE_MANIFEST_CID;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("sends to a STANDARD queue without MessageGroupId / MessageDeduplicationId", async () => {
    process.env.PERMIT_HARVEST_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/000000000000/elephant-oracle-node-property-first-permit-queue";

    const result = parseResult(
      (await getPropertyPermitsHandler({
        parcelId: "test-parcel-no-fifo",
      })) as { content: Array<{ text: string }> },
    );

    expect(result.status).toBe("enqueued");
    expect(sqsSend).toHaveBeenCalledTimes(1);
    expect(sendMessageInputs).toHaveLength(1);

    const input = sendMessageInputs[0];
    expect(input.QueueUrl).toBe(process.env.PERMIT_HARVEST_QUEUE_URL);
    expect(typeof input.MessageBody).toBe("string");
    // FIFO-only params must NOT be present — AWS rejects them on a STANDARD
    // queue with InvalidParameterValue.
    expect(input).not.toHaveProperty("MessageGroupId");
    expect(input).not.toHaveProperty("MessageDeduplicationId");

    // On-demand harvests must carry onDemand:true so the worker relaxes the
    // eligibility and appraiser-link gates and the permits land in Neon.
    const body = JSON.parse(input.MessageBody) as {
      type: string;
      parcelIdentifier: string;
      onDemand?: unknown;
    };
    expect(body.type).toBe("lee-property-first-permit-parcel");
    expect(body.parcelIdentifier).toBe("test-parcel-no-fifo");
    expect(body.onDemand).toBe(true);
  });

  it("returns a clear 'not configured' error when PERMIT_HARVEST_QUEUE_URL is unset", async () => {
    delete process.env.PERMIT_HARVEST_QUEUE_URL;

    const result = parseResult(
      (await getPropertyPermitsHandler({
        parcelId: "test-parcel-unset-queue",
      })) as { content: Array<{ text: string }> },
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/permit queue not configured/i);
    // No hardcoded fallback: nothing should have been sent.
    expect(sqsSend).not.toHaveBeenCalled();
  });
});
