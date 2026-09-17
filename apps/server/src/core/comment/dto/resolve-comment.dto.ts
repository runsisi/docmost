import { IsBoolean } from 'class-validator';
import { CommentIdDto } from './comments.input';

export class ResolveCommentDto extends CommentIdDto {
  @IsBoolean()
  resolved: boolean;
}
