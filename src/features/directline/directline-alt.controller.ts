import { Body, Controller, Headers, Param, Post, HttpCode } from '@nestjs/common';
import { Activity } from 'botframework-schema';
import { DirectlineConversationService } from './directline-conversation.service';

@Controller('v3')
export class DirectlineAltController {
    constructor(private readonly directLineService: DirectlineConversationService) {}

    @Post('conversations/:convId/activities/:activityId')
    @HttpCode(200)
    replyToActivity(
        @Param('convId') convId: string,
        @Param('activityId') activityId: string,
        @Body() activity: Activity,
        @Headers('authorization') securityKey: string
    ): unknown {
        return this.directLineService.replyToActivity(convId, activity, securityKey, activityId);
    }

    @Post('conversations/:convId/activities')
    @HttpCode(200)
    sendToConversation(
        @Param('convId') convId: string,
        @Body() activity: Activity,
        @Headers('authorization') securityKey: string
    ): unknown {
        return this.directLineService.replyToActivity(convId, activity, securityKey);
    }
}
