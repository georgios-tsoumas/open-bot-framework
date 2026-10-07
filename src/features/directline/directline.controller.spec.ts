import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { DirectlineConversationService } from './directline-conversation.service';
import { DirectlineTokenService } from './dirtectline-token.service';
import { DirectlineController } from './directline.controller';

type Part = { type: 'file'; fieldname: string; filename: string; mimetype: string; toBuffer: () => Promise<Buffer> };

const filePart = (fieldname: string, content: string): Part => ({
    type: 'file',
    fieldname,
    filename: `${fieldname}.bin`,
    mimetype: 'application/octet-stream',
    toBuffer: () => Promise.resolve(Buffer.from(content))
});

const requestWith = (...parts: Part[]) =>
    ({
        parts: async function* () {
            for (const part of parts) {
                yield await Promise.resolve(part);
            }
        }
    }) as unknown as FastifyRequest;

describe('DirectlineController upload', () => {
    const userReplyToConversation = jest.fn().mockResolvedValue({ id: 'conv1|0000001' });
    const verifyConversationToken = jest.fn();
    const controller = new DirectlineController(
        { userReplyToConversation, verifyConversationToken } as unknown as DirectlineConversationService,
        {} as DirectlineTokenService
    );

    beforeEach(() => {
        userReplyToConversation.mockClear();
        verifyConversationToken.mockReset();
    });

    it('does not read any part when the token is rejected', async () => {
        verifyConversationToken.mockImplementation(() => {
            throw new UnauthorizedException();
        });
        const toBuffer = jest.fn();
        const req = requestWith({ ...filePart('file', 'data'), toBuffer });
        await expect(controller.uploadToConversation('conv1', 'Bearer bad', '', req)).rejects.toThrow(
            UnauthorizedException
        );
        expect(toBuffer).not.toHaveBeenCalled();
    });

    it('passes the activity and files to the service', async () => {
        const req = requestWith(filePart('activity', '{"type":"message"}'), filePart('file', 'data'));
        await controller.uploadToConversation('conv1', 'Bearer t', '', req);
        expect(userReplyToConversation).toHaveBeenCalledWith('conv1', { type: 'message' }, 'Bearer t', [
            expect.objectContaining({ fieldname: 'file' })
        ]);
    });

    it('returns 400 when the activity part is not JSON', async () => {
        await expect(
            controller.uploadToConversation('conv1', 'Bearer t', '', requestWith(filePart('activity', '{nope')))
        ).rejects.toThrow(BadRequestException);
    });

    it('keeps the 413 status of a file that is too large', async () => {
        const tooLarge = Object.assign(new Error('request file too large'), {
            code: 'FST_REQ_FILE_TOO_LARGE',
            statusCode: 413
        });
        const part = { ...filePart('file', ''), toBuffer: () => Promise.reject(tooLarge) };
        const error = await controller
            .uploadToConversation('conv1', 'Bearer t', '', requestWith(part))
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(413);
    });
});
