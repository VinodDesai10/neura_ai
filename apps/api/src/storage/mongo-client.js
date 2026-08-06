import { MongoClient } from "mongodb";

let mongoClient = null;
let connectPromise = null;
let initPromise = null;

function isMongoEnabled() {
  return Boolean(process.env.MONGODB_URI);
}

function getDatabaseName() {
  return process.env.MONGODB_DATABASE || "neura_ai";
}

function getRawEventsCollectionName() {
  return process.env.MONGODB_RAW_EVENTS_COLLECTION || "raw_events";
}

async function getMongoClient() {
  if (!isMongoEnabled()) {
    return null;
  }

  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000
    });
  }

  if (!connectPromise) {
    connectPromise = mongoClient.connect().catch((error) => {
      connectPromise = null;
      throw error;
    });
  }

  await connectPromise;
  return mongoClient;
}

export async function getMongoRawEventsCollection() {
  const client = await getMongoClient();

  if (!client) {
    return null;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const collection = client
        .db(getDatabaseName())
        .collection(getRawEventsCollectionName());

      await collection.createIndex({ id: 1 }, { unique: true });
      await collection.createIndex({ sessionId: 1, createdAt: -1 });
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  await initPromise;
  return client.db(getDatabaseName()).collection(getRawEventsCollectionName());
}

export async function getMongoHealth() {
  if (!isMongoEnabled()) {
    return {
      configured: false,
      ok: false,
      message: "MONGODB_URI is not set"
    };
  }

  try {
    const client = await getMongoClient();
    await client.db(getDatabaseName()).command({ ping: 1 });
    await getMongoRawEventsCollection();

    return {
      configured: true,
      ok: true,
      message: "reachable",
      database: getDatabaseName(),
      rawEventsCollection: getRawEventsCollectionName()
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: error instanceof Error ? error.message : "Unknown MongoDB error"
    };
  }
}
