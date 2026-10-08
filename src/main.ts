import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import { ClassSerializerInterceptor, HttpException, HttpStatus } from '@nestjs/common';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { AllExceptionsFilter } from './filters/exception.filter';

async function bootstrap() {
    // Proxies in front of OBF. Client IP comes from X-Forwarded-For, or the connection IP when it is missing
    const trustProxy = Number(process.env.TRUST_PROXY_HOPS ?? 1);
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy }));
    await app.register(multipart, {
        limits: {
            fileSize: (Number(process.env.UPLOAD_MAX_FILE_MB) || 10) * 1024 * 1024,
            files: Number(process.env.UPLOAD_MAX_FILES) || 5
        }
    });
    // Only routes with @RouteConfig({ rateLimit }) are limited
    await app.register(rateLimit, {
        global: false,
        errorResponseBuilder: () => new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS)
    });
    app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.enableCors({
        origin: true,
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS'
    });
    await app.listen(process.env.PORT ?? 1986, '0.0.0.0');
}
console.log(` _____                                                                                  _____ 
( ___ )                                                                                ( ___ )
 |   |~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|   | 
 |   |                                                                                  |   | 
 |   |   ██████╗ ██████╗ ███████╗███╗   ██╗    ██████╗  ██████╗ ████████╗               |   | 
 |   |  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║    ██╔══██╗██╔═══██╗╚══██╔══╝               |   | 
 |   |  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║    ██████╔╝██║   ██║   ██║                  |   | 
 |   |  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║    ██╔══██╗██║   ██║   ██║                  |   | 
 |   |  ╚██████╔╝██║     ███████╗██║ ╚████║    ██████╔╝╚██████╔╝   ██║                  |   | 
 |   |   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝    ╚═════╝  ╚═════╝    ╚═╝                  |   | 
 |   |                                                                                  |   | 
 |   |  ███████╗██████╗  █████╗ ███╗   ███╗███████╗██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗  |   | 
 |   |  ██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔════╝██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝  |   | 
 |   |  █████╗  ██████╔╝███████║██╔████╔██║█████╗  ██║ █╗ ██║██║   ██║██████╔╝█████╔╝   |   | 
 |   |  ██╔══╝  ██╔══██╗██╔══██║██║╚██╔╝██║██╔══╝  ██║███╗██║██║   ██║██╔══██╗██╔═██╗   |   | 
 |   |  ██║     ██║  ██║██║  ██║██║ ╚═╝ ██║███████╗╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗  |   | 
 |   |  ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝ ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  |   | 
 |   |                                                                                  |   | 
 |___|~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|___| 
(_____)                                                                                (_____)`);
void bootstrap();
