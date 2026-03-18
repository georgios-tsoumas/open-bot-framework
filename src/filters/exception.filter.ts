import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private logger = new Logger(AllExceptionsFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const request = ctx.getRequest<FastifyRequest>();
        const response = ctx.getResponse<FastifyReply>();

        const isHttpException = exception instanceof HttpException;
        const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
        const message = isHttpException ? exception.message : String(exception);
        const description = isHttpException ? exception.getResponse() : '';

        if (status === HttpStatus.INTERNAL_SERVER_ERROR.valueOf()) {
            this.logger.error(`${message}. ${JSON.stringify(description)}`);
        } else {
            this.logger.verbose(`${message}. ${JSON.stringify(description)}`);
        }

        response.status(status).send({
            statusCode: status,
            timestamp: new Date().toISOString(),
            message,
            path: request.url,
            description
        });
    }
}
