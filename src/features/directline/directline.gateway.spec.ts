import { EventEmitter } from 'events';
import { IncomingMessage } from 'http';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WebSocket } from 'ws';
import { WebChatService } from '../channels/webchat/webchat.service';
import { DirectlineTokenService } from './dirtectline-token.service';
import { DirectLineGateway } from './directline.gateway';

class FakeSocket extends EventEmitter {
    send = jest.fn();
    close = jest.fn();
}

describe('DirectLineGateway', () => {
    const configService = { get: () => undefined } as unknown as ConfigService;
    const tokenService = new DirectlineTokenService(
        {} as WebChatService,
        configService,
        new JwtService({ secret: 'test-secret' })
    );
    const token = tokenService.createToken({ bot: 'bot', site: 'site1', conv: 'conv1' }, 60);
    const streamPath = (t?: string) =>
        `/v3/directline/conversations/conv1/stream?watermark=-${t === undefined ? '' : `&t=${t}`}`;

    let gateway: DirectLineGateway;
    const connect = (url: string) => {
        const ws = new FakeSocket();
        gateway.handleConnection(ws as unknown as WebSocket, { url } as IncomingMessage);
        return ws;
    };
    const registered = () => gateway['socketMeta'];

    beforeEach(() => {
        gateway = new DirectLineGateway(tokenService, configService);
    });

    it('registers a socket with a valid token', () => {
        const ws = connect(streamPath(token));
        expect(ws.close).not.toHaveBeenCalled();
        expect(registered().get('conv1')).toBe(ws);
    });

    it.each([
        ['no token', streamPath()],
        ['a bad token', streamPath('not-a-jwt')],
        ['a token for another conversation', streamPath(token).replace('conv1', 'conv2')]
    ])('closes a socket with %s', (_label, url) => {
        const ws = connect(url);
        expect(ws.close).toHaveBeenCalledWith(1008);
        expect(registered().size).toBe(0);
    });

    it('forgets a socket once it closes', () => {
        const ws = connect(streamPath(token));
        ws.emit('close');
        expect(registered().has('conv1')).toBe(false);
    });

    it('keeps the newer socket when an older one for the same conversation closes', () => {
        const older = connect(streamPath(token));
        const newer = connect(streamPath(token));
        older.emit('close');
        expect(registered().get('conv1')).toBe(newer);
    });
});
