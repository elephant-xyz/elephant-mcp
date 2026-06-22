import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { fetchFromIpfs } from "../lib/ipfs.ts";
import {
  PermitCacheEntrySchema,
  type GetPropertyPermitsResult,
} from "../types/permits.ts";

// ---------------------------------------------------------------------------
// Configuration — all overridable via environment variables
// ---------------------------------------------------------------------------

const DEFAULT_PERMIT_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/848665034107/elephant-oracle-node-property-first-permit-queue";

const DEFAULT_PERMIT_OUTPUT_PREFIX =
  "s3://elephant-oracle-node-permit-harvest/permit-harvest/mcp-on-demand";

function getPermitQueueUrl(): string {
  return process.env.PERMIT_HARVEST_QUEUE_URL ?? DEFAULT_PERMIT_QUEUE_URL;
}

function getPermitOutputPrefix(): string {
  return process.env.PERMIT_HARVEST_OUTPUT_PREFIX ?? DEFAULT_PERMIT_OUTPUT_PREFIX;
}

function getPermitCacheManifestCid(): string | undefined {
  return process.env.PERMIT_CACHE_MANIFEST_CID;
}

// ---------------------------------------------------------------------------
// In-process permit cache: parcelId → { cid, harvestedAt, permits[] }
// This is a best-effort write-through cache; the canonical store is IPFS.
// ---------------------------------------------------------------------------

interface PermitInMemoryEntry {
  permits: unknown[];
  harvestedAt: string;
  cid?: string;
}

const permitCache = new Map<string, PermitInMemoryEntry>();

// ---------------------------------------------------------------------------
// SQS client (lazy singleton)
// ---------------------------------------------------------------------------

let sqsClient: SQSClient | null = null;

function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return sqsClient;
}

// ---------------------------------------------------------------------------
// Cache read: try IPFS manifest CID first, fall back to in-process map
// ---------------------------------------------------------------------------

async function lookupPermitsFromIpfs(
  parcelId: string,
): Promise<PermitInMemoryEntry | null> {
  const manifestCid = getPermitCacheManifestCid();
  if (!manifestCid) return null;

  try {
    const manifestText = await fetchFromIpfs(manifestCid);
    const manifest = JSON.parse(manifestText) as {
      entries?: Array<{ parcelId: string; cid: string; harvestedAt: string }>;
    };

    const entry = manifest.entries?.find((e) => e.parcelId === parcelId);
    if (!entry) return null;

    const permitText = await fetchFromIpfs(entry.cid);
    const raw = JSON.parse(permitText);
    const parsed = PermitCacheEntrySchema.safeParse(raw);

    if (!parsed.success) {
      logger.warn(
        { parcelId, error: parsed.error.message },
        "Permit cache entry failed schema validation",
      );
      return null;
    }

    return {
      permits: parsed.data.permits,
      harvestedAt: parsed.data.harvestedAt,
      cid: entry.cid,
    };
  } catch (error) {
    logger.debug(
      { parcelId, error: error instanceof Error ? error.message : String(error) },
      "IPFS permit cache lookup failed — will enqueue harvest",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Harvest enqueueing: send a lee-property-first-permit-parcel message to SQS
// ---------------------------------------------------------------------------

async function enqueuePermitHarvest(
  parcelId: string,
  countyFips: string,
): Promise<void> {
  const jobId = `mcp-on-demand-${countyFips}-${Date.now()}`;

  const message = {
    type: "lee-property-first-permit-parcel",
    version: 1,
    jobId,
    parcelIdentifier: parcelId,
    outputPrefix: getPermitOutputPrefix(),
  };

  const command = new SendMessageCommand({
    QueueUrl: getPermitQueueUrl(),
    MessageBody: JSON.stringify(message),
    MessageGroupId: parcelId,
  });

  const sqs = getSqsClient();
  await sqs.send(command);

  logger.info(
    { parcelId, countyFips, jobId },
    "Permit harvest job enqueued to SQS",
  );
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function getPropertyPermitsHandler(args: {
  parcelId: string;
  countyFips?: string;
}) {
  const parcelId = args.parcelId.trim();
  const countyFips = args.countyFips ?? "12071";

  // 1. Check in-process cache first (fastest path — already fetched this session)
  const inProcessEntry = permitCache.get(parcelId);
  if (inProcessEntry) {
    const result: GetPropertyPermitsResult = {
      status: "cached",
      parcelId,
      countyFips,
      permits: inProcessEntry.permits as never,
      harvestedAt: inProcessEntry.harvestedAt,
      cid: inProcessEntry.cid,
    };
    return createTextResult(result);
  }

  // 2. Try IPFS cache
  try {
    const ipfsEntry = await lookupPermitsFromIpfs(parcelId);
    if (ipfsEntry) {
      permitCache.set(parcelId, ipfsEntry);

      const result: GetPropertyPermitsResult = {
        status: "cached",
        parcelId,
        countyFips,
        permits: ipfsEntry.permits as never,
        harvestedAt: ipfsEntry.harvestedAt,
        cid: ipfsEntry.cid,
      };
      return createTextResult(result);
    }
  } catch (error) {
    logger.warn(
      { parcelId, error: error instanceof Error ? error.message : String(error) },
      "IPFS permit lookup failed — proceeding to enqueue",
    );
  }

  // 3. No cache hit — enqueue async harvest and return status
  try {
    await enqueuePermitHarvest(parcelId, countyFips);

    const result: GetPropertyPermitsResult = {
      status: "enqueued",
      parcelId,
      countyFips,
      message:
        "Permit harvest job enqueued. Accela scraping typically takes 60–90 seconds. Call getPropertyPermits again after ~90 seconds to retrieve results.",
      estimatedWaitSeconds: 90,
    };
    return createTextResult(result);
  } catch (error) {
    logger.error(
      {
        parcelId,
        countyFips,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to enqueue permit harvest",
    );

    const result: GetPropertyPermitsResult = {
      status: "error",
      parcelId,
      countyFips,
      message: `Failed to enqueue permit harvest: ${error instanceof Error ? error.message : String(error)}`,
    };
    return createTextResult(result);
  }
}
