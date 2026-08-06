import { ensurePostgresReady, getPostgresClient } from "./postgres-client.js";
import { getMongoRawEventsCollection } from "./mongo-client.js";
import { linkEventToSession } from "./relationship-graph-store.js";

const rawEvents = [];

export const rawEventVault = {
  async append({ sessionId, role, content }) {
    const event = {
      id: crypto.randomUUID(),
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString()
    };

    const mongoCollection = await getMongoRawEventsCollection();

    if (mongoCollection) {
      await mongoCollection.insertOne(event);
      await linkEventToSession(event);
      return event;
    }

    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();
      await sql`
        insert into raw_events (
          id,
          session_id,
          role,
          content,
          created_at
        ) values (
          ${event.id},
          ${event.sessionId},
          ${event.role},
          ${event.content},
          ${event.createdAt}
        )
      `;
      await linkEventToSession(event);
      return event;
    }

    rawEvents.push(event);
    await linkEventToSession(event);
    return event;
  },

  async findRecentBySession(sessionId, limit = 6) {
    const mongoCollection = await getMongoRawEventsCollection();

    if (mongoCollection) {
      return mongoCollection
        .find(
          { sessionId },
          {
            projection: {
              _id: 0
            }
          }
        )
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray()
        .then((events) => events.reverse());
    }

    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();
      const rows = await sql`
        select id, session_id, role, content, created_at
        from raw_events
        where session_id = ${sessionId}
        order by created_at desc
        limit ${limit}
      `;

      return rows
        .slice()
        .reverse()
        .map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          role: row.role,
          content: row.content,
          createdAt: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at
        }));
    }

    return rawEvents
      .filter((event) => event.sessionId === sessionId)
      .slice(-limit);
  },

  async all() {
    const mongoCollection = await getMongoRawEventsCollection();

    if (mongoCollection) {
      return mongoCollection
        .find(
          {},
          {
            projection: {
              _id: 0
            }
          }
        )
        .sort({ createdAt: 1 })
        .limit(Number(process.env.DEBUG_RAW_EVENT_LIMIT || 200))
        .toArray();
    }

    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();
      const rows = await sql`
        select id, session_id, role, content, created_at
        from raw_events
        order by created_at asc
      `;

      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at
      }));
    }

    return rawEvents;
  }
};
