import amqplib from "amqplib";
import {env} from "../../src/lib/config/env";
import {AmqpConnection} from "./types";

/**
 * Side-channel to the real RabbitMQ broker for arranging / asserting broker
 * state (purge a queue, count dead-lettered messages, catch published events).
 * The code under test still uses its own RabbitMQClient.
 */
export class AmqpProbe {
    private constructor(private readonly conn: AmqpConnection) {}

    static async open(): Promise<AmqpProbe> {
        const conn = await amqplib.connect(env.rabbit.url);
        conn.on("error", () => {}); // a broker-closed connection must not crash the test process
        return new AmqpProbe(conn);
    }

    /** Removes queued messages; no-op if the queue doesn't exist yet. */
    async purge(queue: string): Promise<void> {
        await this.withChannel(async (ch) => {
            await ch.purgeQueue(queue);
        });
    }

    /** Ready messages in `queue` (0 if it doesn't exist). */
    async messageCount(queue: string): Promise<number> {
        let count = 0;
        await this.withChannel(async (ch) => {
            count = (await ch.checkQueue(queue)).messageCount;
        });
        return count;
    }

    /** Pops one message (auto-ack), or null when the queue is empty. */
    async pop(queue: string): Promise<{routingKey: string; body: unknown} | null> {
        let out: {routingKey: string; body: unknown} | null = null;
        await this.withChannel(async (ch) => {
            const msg = await ch.get(queue, {noAck: true});
            if (msg) out = {routingKey: msg.fields.routingKey, body: JSON.parse(msg.content.toString("utf8"))};
        });
        return out;
    }

    /**
     * Durable topic exchange + a queue bound to it with `#`. The queue is
     * exclusive to this probe's connection (RabbitMQ 4 rejects transient
     * non-exclusive queues) and vanishes when the probe closes.
     */
    async bindCatchAllQueue(exchange: string, queue: string): Promise<string> {
        await this.withChannel(async (ch) => {
            await ch.assertExchange(exchange, "topic", {durable: true});
            await ch.assertQueue(queue, {exclusive: true, durable: false});
            await ch.purgeQueue(queue);
            await ch.bindQueue(queue, exchange, "#");
        });
        return queue;
    }

    async deleteQueue(queue: string): Promise<void> {
        await this.withChannel(async (ch) => {
            await ch.deleteQueue(queue);
        });
    }

    async close(): Promise<void> {
        await this.conn.close();
    }

    // A broker-side error (e.g. 404 on a missing queue) closes the channel, so
    // every probe operation gets its own short-lived channel.
    private async withChannel(fn: (ch: Awaited<ReturnType<AmqpConnection["createChannel"]>>) => Promise<void>): Promise<void> {
        const ch = await this.conn.createChannel();
        ch.on("error", () => {});
        try {
            await fn(ch);
        } catch (err) {
            if ((err as {code?: number}).code !== 404) throw err;
        } finally {
            await ch.close().catch(() => {});
        }
    }
}
