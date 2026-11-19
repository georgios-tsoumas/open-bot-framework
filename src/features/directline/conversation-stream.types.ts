import { Activity } from 'botframework-schema';

/** A non-typing activity kept for replay. `seq` identifies the activity; `cursor` orders delivery. */
export interface StoredActivity {
    seq: number;
    activity: Activity;
    cursor?: string;
}

/** Message on a conversation's pub/sub channel. `seq` is null for typing (never stored or replayed). */
export interface ConversationMessage {
    seq: number | null;
    activity: Activity;
    cursor?: string;
}

/** Frame sent to the client. DirectLine clients track `watermark` and send it back on reconnect. */
export interface ActivitySetFrame {
    activities: Activity[];
    watermark?: string;
}

export const CHANNEL_PREFIX = 'obf:conv:';

export const conversationChannel = (conversationId: string): string => `${CHANNEL_PREFIX}${conversationId}`;

export const activityStoreKey = (conversationId: string): string => `${CHANNEL_PREFIX}${conversationId}:activities`;

export const activityStreamKey = (conversationId: string): string => `${CHANNEL_PREFIX}${conversationId}:stream`;

/** Versioned Redis stream IDs are opaque to DirectLine clients. Bound both unsigned components. */
export const isDeliveryCursor = (raw: string | null | undefined): raw is string => {
    if (!/^v2:(0|[1-9]\d{0,19})-(0|[1-9]\d{0,19})$/.test(raw ?? '')) {
        return false;
    }
    return raw!
        .slice(3)
        .split('-')
        .every(part => BigInt(part) <= 18446744073709551615n);
};

export const compareDeliveryCursors = (left: string, right: string): number => {
    const [leftTime, leftSeq] = left.slice(3).split('-').map(BigInt);
    const [rightTime, rightSeq] = right.slice(3).split('-').map(BigInt);
    return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0;
};

/** Accept numeric cursors from older releases as well as versioned delivery cursors. */
export const isWatermark = (raw: string | null | undefined): raw is string =>
    /^\d+$/.test(raw ?? '') || isDeliveryCursor(raw);

/** Frame for one live message. Typing carries no watermark, so the client keeps its last one. */
export const toFrame = ({ seq, activity, cursor }: ConversationMessage): ActivitySetFrame =>
    seq === null ? { activities: [activity] } : { activities: [activity], watermark: cursor ?? String(seq) };
