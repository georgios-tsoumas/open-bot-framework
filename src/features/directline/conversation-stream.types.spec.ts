import { compareDeliveryCursors, isDeliveryCursor, isWatermark } from './conversation-stream.types';

describe('versioned delivery cursors', () => {
    it.each(['v2:0-0', 'v2:1700000000000-12', 'v2:18446744073709551615-18446744073709551615'])(
        'accepts a bounded stream cursor %s',
        cursor => expect(isDeliveryCursor(cursor)).toBe(true)
    );

    it.each(['v2:1', 'v2:-1-0', 'v2:01-0', 'v2:1-2x', 'v2:18446744073709551616-0', 'v2:0-18446744073709551616'])(
        'rejects malformed or overflowing cursor %s',
        cursor => expect(isDeliveryCursor(cursor)).toBe(false)
    );

    it('compares stream components without losing integer precision', () => {
        expect(compareDeliveryCursors('v2:9007199254740993-0', 'v2:9007199254740992-99')).toBe(1);
        expect(compareDeliveryCursors('v2:10-9', 'v2:10-10')).toBe(-1);
        expect(compareDeliveryCursors('v2:10-10', 'v2:10-10')).toBe(0);
    });

    it('accepts legacy numeric watermarks without confusing them with delivery cursors', () => {
        expect(isWatermark('42')).toBe(true);
        expect(isDeliveryCursor('42')).toBe(false);
        expect(isWatermark('v2:10-2')).toBe(true);
        expect(isWatermark('-')).toBe(false);
    });
});
