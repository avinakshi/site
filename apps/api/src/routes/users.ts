import type { FastifyPluginAsync } from 'fastify';
import {
  createProblem,
  createUserRequestSchema,
  listUsersQuerySchema,
  listUsersResponseSchema,
  meResponseSchema,
  updateUserRequestSchema,
  userIdParamSchema,
  type CreateUserRequest,
  type ListUsersQuery,
  type UpdateUserRequest,
  type UserIdParam,
} from '@csm-chat/shared';
import type { UserService } from '../services/user.service.js';

export interface UsersRoutesOptions {
  userService: UserService;
}

const usersRoutes: FastifyPluginAsync<UsersRoutesOptions> = async (app, opts) => {
  const { userService } = opts;

  // GET /v1/users — admin only
  app.get(
    '/v1/users',
    {
      preHandler: app.requireAdmin,
      schema: {
        querystring: listUsersQuerySchema,
        response: { 200: listUsersResponseSchema },
      },
    },
    async (req) => {
      const query = req.query as ListUsersQuery;
      return userService.list(query, { requestId: req.id, instance: req.url });
    },
  );

  // POST /v1/users — admin only
  app.post(
    '/v1/users',
    {
      preHandler: app.requireAdmin,
      schema: {
        body: createUserRequestSchema,
        response: { 201: meResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body as CreateUserRequest;
      const created = await userService.create(body, { requestId: req.id, instance: req.url });
      reply.status(201);
      return created;
    },
  );

  // GET /v1/users/:userId — admin: any; CSM: self only
  app.get(
    '/v1/users/:userId',
    {
      preHandler: app.verifyAuth,
      schema: {
        params: userIdParamSchema,
        response: { 200: meResponseSchema },
      },
    },
    async (req) => {
      if (!req.user) throw new Error('preHandler did not set req.user');
      const { userId } = req.params as UserIdParam;
      if (req.user.role !== 'admin' && req.user.id !== userId) {
        throw createProblem('FORBIDDEN', {
          requestId: req.id,
          instance: req.url,
          detail: 'CSMs may only view their own profile via this endpoint.',
        });
      }
      return userService.getById(userId, { requestId: req.id, instance: req.url });
    },
  );

  // PATCH /v1/users/:userId — admin only
  app.patch(
    '/v1/users/:userId',
    {
      preHandler: app.requireAdmin,
      schema: {
        params: userIdParamSchema,
        body: updateUserRequestSchema,
        response: { 200: meResponseSchema },
      },
    },
    async (req) => {
      const { userId } = req.params as UserIdParam;
      const body = req.body as UpdateUserRequest;
      return userService.update(userId, body, { requestId: req.id, instance: req.url });
    },
  );

  // DELETE /v1/users/:userId — admin only (soft delete → 204)
  app.delete(
    '/v1/users/:userId',
    {
      preHandler: app.requireAdmin,
      schema: { params: userIdParamSchema },
    },
    async (req, reply) => {
      const { userId } = req.params as UserIdParam;
      await userService.softDelete(userId, { requestId: req.id, instance: req.url });
      reply.status(204);
      return null;
    },
  );
};

export default usersRoutes;
