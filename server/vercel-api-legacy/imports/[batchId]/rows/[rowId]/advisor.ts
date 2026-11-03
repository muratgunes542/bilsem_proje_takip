import type { IncomingMessage, ServerResponse } from 'node:http'
import { dispatchNodeApi } from '../../../../../../server/api/router'

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await dispatchNodeApi(req, res)
}
