import type { FastifyPluginAsync } from 'fastify';
import {
  clientIdParamSchema,
  clientSchema,
  listClientsQuerySchema,
  listClientsResponseSchema,
  type ClientIdParam,
  type ListClientsQuery,
} from '@csm-chat/shared';
import type { ClientService } from '../services/client.service.js';

export interface ClientsRoutesOptions {
  clientService: ClientService;
}

const clientsRoutes: FastifyPluginAsync<ClientsRoutesOptions> = async (app, opts) => {
  const { clientService } = opts;

  app.get(
    '/v1/clients',
    {
      preHandler: app.verifyAuth,
      schema: {
        querystring: listClientsQuerySchema,
        response: { 200: listClientsResponseSchema },
      },
    },
    async (req) => {
      return clientService.list(req.query as ListClientsQuery);
    },
  );

  app.get(
    '/v1/clients/:clientId',
    {
      preHandler: app.verifyAuth,
      schema: {
        params: clientIdParamSchema,
        response: { 200: clientSchema },
      },
    },
    async (req) => {
      const { clientId } = req.params as ClientIdParam;
      return clientService.getById(clientId, { requestId: req.id, instance: req.url });
    },
  );
};

export default clientsRoutes;
