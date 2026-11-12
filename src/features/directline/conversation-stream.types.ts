import { Activity } from 'botframework-schema';

/** A non-typing activity kept for replay. `seq` is its watermark and the numeric suffix of its id. */
export interface StoredActivity {
    seq: number;
    activity: Activity;
}

/** Message on a conversation's pub/sub channel. `seq` is null for typing (never stored or replayed). */
export interface ConversationMessage {
    seq: number | null;
    activity: Activity;
}

/** Frame sent to the client. DirectLine clients track `watermark` and send it back on reconnect. */
export interface ActivitySetFrame {
    activities: Activity[];
    watermark?: string;
}

export const CHANNEL_PREFIX = 'obf:conv:';

export const conversationChannel = (conversationId: string): string => `${CHANNEL_PREFIX}${conversationId}`;

export const activityStoreKey = (conversationId: string): string => `${CHANNEL_PREFIX}${conversationId}:activities`;

/** A watermark is a seq. Clients send none, or '-', when they have seen nothing yet. */
export const isWatermark = (raw: string | null | undefined): raw is string => /^\d+$/.test(raw ?? '');

/** Frame for one live message. Typing carries no watermark, so the client keeps its last one. */
export const toFrame = ({ seq, activity }: ConversationMessage): ActivitySetFrame =>
    seq === null ? { activities: [activity] } : { activities: [activity], watermark: String(seq) };
