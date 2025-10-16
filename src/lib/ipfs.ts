import { createHelia, type Helia } from "helia";
import { json as createJsonClient, type Json } from "@helia/json";
import { CID } from "multiformats/cid";
import { logger } from "../logger.ts";

let heliaInstance: Helia | null = null;
let jsonClient: Json | null = null;

async function getHelia(): Promise<Helia> {
  if (!heliaInstance) {
    logger.info("Initializing Helia instance");
    heliaInstance = await createHelia();
  }
  return heliaInstance;
}

async function getJsonClient(): Promise<Json> {
  if (!jsonClient) {
    const helia = await getHelia();
    jsonClient = createJsonClient(helia);
  }
  return jsonClient;
}

export async function getJsonByCid<T>(cidString: string): Promise<T> {
  try {
    const json = await getJsonClient();
    const cid = CID.parse(cidString);
    const data = await json.get(cid);
    return data as T;
  } catch (error) {
    logger.error("Failed to fetch JSON by CID", {
      cid: cidString,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
