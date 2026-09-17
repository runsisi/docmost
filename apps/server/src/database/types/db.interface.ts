import { DB, Generated, Timestamp } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';

export interface DbInterface extends DB {
  giteaAccounts: {
    id: Generated<string>;
    workspaceId: string;
    userId: string;
    issuer: string;
    subject: string;
    createdAt: Generated<Timestamp>;
  };
  pageEmbeddings: PageEmbeddings;
}
