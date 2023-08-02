import { MessageSFPUserAddError, StatusAddUserError } from '../../constants'
import GraphQLError from '../../utils/GraphQLError'
import type { ImpersonateMetricParams } from '../../utils/metrics/impersonate'
import {
  sendImpersonateB2BUserMetric,
  sendImpersonateUserMetric,
} from '../../utils/metrics/impersonate'

export const getUserRoleSlug: (
  id: string,
  ctx: Context
) => Promise<string> = async (id, ctx) => {
  const {
    clients: { storefrontPermissions },
    vtex: { logger },
  } = ctx

  return storefrontPermissions
    .getUser(id)
    .then((result: any) => {
      return result.data.getUser
    })
    .then((userData: any) => {
      return storefrontPermissions.getRole(userData.roleId)
    })
    .then((result: any) => {
      return result?.data?.getRole?.slug ?? ''
    })
    .catch((error: any) => {
      logger.warn({
        error,
        message: 'getUserRoleSlug-error',
      })

      return ''
    })
}

const isUserPermitted = ({
  storefrontPermissions,
  sessionData,
  orgId,
  roleSlug,
}: any) =>
  (storefrontPermissions?.permissions?.includes('add-users-organization') &&
    sessionData.namespaces['storefront-permissions'].organization.value ===
      orgId &&
    !roleSlug.includes('sales')) ||
  (storefrontPermissions?.permissions?.includes('add-sales-users-all') &&
    roleSlug.includes('sales'))

const getRoleSlug = async ({
  clId,
  ctx,
  logger,
  roleId,
  storefrontPermissionsClient,
}: any) =>
  clId
    ? getUserRoleSlug(clId, ctx)
    : storefrontPermissionsClient
        .getRole(roleId)
        .then((result: any) => {
          return result?.data?.getRole?.slug ?? ''
        })
        .catch((error: any) => {
          logger.warn({
            error,
            message: 'saveUser-getRoleError',
          })

          return ''
        })

const getUser = async ({ masterdata, logger, userId, clId }: any) =>
  (await masterdata
    .getDocument({
      dataEntity: 'CL',
      fields: ['userId'],
      id: clId,
    })
    .then((res: any) => {
      return res?.userId ?? undefined
    })
    .catch((error: any) => {
      logger.error({
        error,
        message: 'saveUser-getDocumentError',
      })

      return error
    })) ?? userId

const checkUserIsAllowed = async ({
  adminUserAuthToken,
  clId,
  ctx,
  logger,
  orgId,
  roleId,
  sessionData,
  storefrontPermissionsClient,
  storefrontPermissions,
}: any) => {
  if (!adminUserAuthToken) {
    if (!sessionData?.namespaces['storefront-permissions']?.organization) {
      throw new GraphQLError('organization-data-not-found')
    }

    const roleSlug = await getRoleSlug({
      clId,
      ctx,
      logger,
      roleId,
      storefrontPermissionsClient,
    })

    const permitted = isUserPermitted({
      orgId,
      roleSlug,
      sessionData,
      storefrontPermissions,
    })

    if (!permitted) {
      throw new GraphQLError('operation-not-permitted')
    }
  }
}

const getUserFromStorefrontPermissions = ({
  clId: clientId,
  storefrontPermissionsClient,
  logger,
}: {
  clId: string
  storefrontPermissionsClient: any
  logger: any
}) =>
  storefrontPermissionsClient
    .getUser(clientId)
    .then((result: any) => {
      return result?.data?.getUser ?? {}
    })
    .catch((error: any) => {
      logger.warn({
        error,
        message: 'impersonateUser-getUserError',
      })

      return error
    })

const Users = {
  impersonateB2BUser: async (_: void, { id }: { id: string }, ctx: Context) => {
    const {
      clients: { storefrontPermissions: storefrontPermissionsClient },

      vtex: { adminUserAuthToken, logger, sessionData, storefrontPermissions },
    } = ctx as Context | any

    const getB2BUserFromStorefrontPermissions = ({
      id: b2bId,
    }: {
      id: string
    }) =>
      storefrontPermissionsClient
        .getB2BUser(b2bId)
        .then((result: any) => result?.data?.getB2BUser ?? {})

    const user = await getB2BUserFromStorefrontPermissions({ id })

    if (!adminUserAuthToken) {
      if (!sessionData?.namespaces['storefront-permissions']?.organization) {
        throw new GraphQLError('organization-data-not-found')
      }

      const roleSlug = await storefrontPermissions.getRole(user.roleId)?.data
        ?.getRole?.slug

      let permitted = false

      if (!roleSlug.includes('sales')) {
        permitted =
          (storefrontPermissions?.permissions?.includes(
            'impersonate-users-costcenter'
          ) &&
            !roleSlug.includes('admin') &&
            user?.costId ===
              sessionData?.namespaces['storefront-permissions']?.costcenter) ||
          (storefrontPermissions?.permissions?.includes(
            'impersonate-users-organization'
          ) &&
            user?.orgId ===
              sessionData?.namespaces['storefront-permissions']
                ?.organization) ||
          storefrontPermissions?.permissions?.includes('impersonate-users-all')
      }

      if (!permitted) {
        throw new GraphQLError('operation-not-permitted')
      }
    }

    const impersonation = await storefrontPermissionsClient
      .impersonateUser({ userId: id })
      .catch((error: any) => {
        logger.error({
          error,
          message: 'impersonateUser-impersonateUserError',
        })

        return { status: 'error', message: error }
      })

    if (impersonation?.errors) {
      throw new GraphQLError(impersonation?.errors)
    }

    const {
      orgId: targetOrganizationId,
      costId: targetCostCenterId,
      id: targetId,
      email: targetEmail,
    } = user

    const metricParams: ImpersonateMetricParams = {
      account: sessionData?.namespaces?.account?.accountName,
      target: {
        costCenterId: targetCostCenterId,
        organizationId: targetOrganizationId,
        email: targetEmail,
        id: targetId,
      },
      user: {
        costCenterId:
          sessionData?.namespaces['storefront-permissions']?.costcenter.value,
        organizationId:
          sessionData?.namespaces['storefront-permissions']?.organization.value,
        email: sessionData?.namespaces?.profile?.email.value,
        id: sessionData?.namespaces['storefront-permissions']?.userId.value,
      },
    }

    sendImpersonateB2BUserMetric(metricParams)

    return (
      impersonation?.data?.impersonateUser ?? {
        status: 'error',
      }
    )
  },
  /**
   *
   * Mutation to impersonate a user
   *
   * @param _
   * @param clId
   * @param userId
   * @param ctx
   */
  impersonateUser: async (
    _: void,
    { clId, userId }: UserArgs,
    ctx: Context
  ) => {
    const {
      clients: {
        masterdata,
        storefrontPermissions: storefrontPermissionsClient,
      },

      vtex: { adminUserAuthToken, logger, sessionData, storefrontPermissions },
    } = ctx as Context | any

    if (!adminUserAuthToken && clId) {
      if (!sessionData?.namespaces['storefront-permissions']?.organization) {
        throw new GraphQLError('organization-data-not-found')
      }

      let permitted = false
      // check the role of the user to be impersonated
      const roleSlug = await getUserRoleSlug(clId, ctx)

      if (!roleSlug.includes('sales')) {
        const userInfo = await getUserFromStorefrontPermissions({
          clId,
          logger,
          storefrontPermissionsClient,
        })

        permitted =
          (storefrontPermissions?.permissions?.includes(
            'impersonate-users-costcenter'
          ) &&
            !roleSlug.includes('admin') &&
            userInfo?.costId ===
              sessionData?.namespaces['storefront-permissions']?.costcenter) ||
          (storefrontPermissions?.permissions?.includes(
            'impersonate-users-organization'
          ) &&
            userInfo?.orgId ===
              sessionData?.namespaces['storefront-permissions']
                ?.organization) ||
          storefrontPermissions?.permissions?.includes('impersonate-users-all')
      }

      if (!permitted) {
        throw new GraphQLError('operation-not-permitted')
      }
    }

    if (!userId && clId) {
      const userIdFromCl = await masterdata
        .getDocument({
          dataEntity: 'CL',
          fields: ['userId'],
          id: clId,
        })
        .then((res: any) => {
          return res?.userId ?? undefined
        })
        .catch((error: any) => {
          logger.warn({
            error,
            message: 'impersonateUser-getUserIdError',
          })

          return error
        })

      if (!userIdFromCl) {
        logger.warn({
          message: `userId ${userIdFromCl} not found in CL`,
        })

        return { status: 'error', message: 'userId not found in CL' }
      }

      userId = userIdFromCl

      const userData = await getUserFromStorefrontPermissions({
        clId,
        logger,
        storefrontPermissionsClient,
      })

      if (userData && !userData.userId) {
        await storefrontPermissionsClient.saveUser({
          ...userData,
          userId,
        })
      }
    }

    return impersonateUser(
      storefrontPermissionsClient,
      userId,
      logger,
      sessionData?.namespaces?.account?.accountName,
      sessionData?.namespaces['storefront-permissions']
    )
  },

  /**
   *
   * Mutation to remove a user
   *
   * @param _
   * @param id
   * @param userId
   * @param email
   * @param clId
   * @param ctx
   */
  removeUser: async (
    _: void,
    { id, userId, email, clId }: UserArgs,
    ctx: Context
  ) => {
    const {
      clients: { storefrontPermissions: storefrontPermissionsClient },
      vtex: { adminUserAuthToken, logger, sessionData, storefrontPermissions },
    } = ctx as Context | any

    if (!id || !clId || !email) {
      throw new GraphQLError('user-information-not-provided')
    }

    if (!adminUserAuthToken) {
      if (!sessionData?.namespaces['storefront-permissions']?.organization) {
        throw new GraphQLError('organization-data-not-found')
      }

      const roleSlug = await getUserRoleSlug(clId, ctx)

      const permitted =
        (storefrontPermissions?.permissions?.includes(
          'remove-users-organization'
        ) &&
          !roleSlug.includes('sales')) ||
        storefrontPermissions?.permissions?.includes('remove-sales-users-all')

      if (!permitted) {
        throw new GraphQLError('operation-not-permitted')
      }
    }

    return storefrontPermissionsClient
      .deleteUser({
        email,
        id,
        userId,
      })
      .then((result: any) => {
        return result.data.deleteUser
      })
      .catch((error: any) => {
        logger.error({
          error,
          message: 'removeUser-deleteUserError',
        })

        return { status: 'error', message: error }
      })
  },

  addUser: async (
    _: void,
    { id, roleId, userId, orgId, costId, clId, name, email }: UserArgs,
    ctx: Context
  ) => {
    const {
      clients: { storefrontPermissions: storefrontPermissionsClient },
      vtex: { adminUserAuthToken, logger, sessionData, storefrontPermissions },
    } = ctx as any

    try {
      await checkUserIsAllowed({
        adminUserAuthToken,
        clId,
        ctx,
        logger,
        orgId,
        roleId,
        sessionData,
        storefrontPermissions,
        storefrontPermissionsClient,
      })
    } catch (error) {
      logger.error({
        error,
        message: 'addUser-checkUserIsAllowedError',
      })
      throw error
    }

    return storefrontPermissionsClient
      .addUser({
        costId,
        email,
        id,
        name,
        orgId,
        roleId,
        userId,
      })
      .then((result: any) => {
        return result.data.addUser
      })
      .catch((error: any) => {
        logger.error({
          error,
          message: 'addUser-error',
        })

        const message = error.graphQLErrors[0]?.message ?? error.message
        let status = ''

        if (message.includes(MessageSFPUserAddError.DUPLICATED)) {
          status = StatusAddUserError.DUPLICATED
        } else if (
          message.includes(MessageSFPUserAddError.DUPLICATED_ORGANIZATION)
        ) {
          status = StatusAddUserError.DUPLICATED_ORGANIZATION
        } else {
          status = StatusAddUserError.ERROR
        }

        return { status, message }
      })
  },

  updateUser: async (
    _: void,
    { id, roleId, userId, orgId, costId, clId, name, email }: UserArgs,
    ctx: Context
  ) => {
    const {
      clients: {
        masterdata,
        storefrontPermissions: storefrontPermissionsClient,
      },
      vtex: { adminUserAuthToken, logger, sessionData, storefrontPermissions },
    } = ctx as any

    try {
      await checkUserIsAllowed({
        adminUserAuthToken,
        clId,
        ctx,
        logger,
        orgId,
        roleId,
        sessionData,
        storefrontPermissions,
        storefrontPermissionsClient,
      })
    } catch (error) {
      logger.error({
        error,
        message: 'addUser-checkUserIsAllowedError',
      })
      throw error
    }

    if (clId && !userId) {
      userId = await getUser({
        clId,
        logger,
        masterdata,
        userId,
      })
    }

    return storefrontPermissionsClient
      .updateUser({
        clId,
        costId,
        email,
        id,
        name,
        orgId,
        roleId,
        userId,
      })
      .then((result: any) => {
        return result.data.updateUser
      })
      .catch((error: any) => {
        logger.error({
          error,
          message: 'updateUser-error',
        })

        return { status: 'error', message: error }
      })
  },

  /**
   *
   * Create and update a user
   *
   * @deprecated
   *
   * @param _
   * @param id
   * @param roleId
   * @param userId
   * @param orgId
   * @param costId
   * @param clId
   * @param name
   * @param email
   * @param ctx
   */
  saveUser: async (
    _: void,
    { id, roleId, userId, orgId, costId, clId, name, email }: UserArgs,
    ctx: Context
  ) => {
    const {
      clients: {
        masterdata,
        storefrontPermissions: storefrontPermissionsClient,
      },
      vtex: { adminUserAuthToken, logger, sessionData, storefrontPermissions },
    } = ctx as any

    try {
      await checkUserIsAllowed({
        adminUserAuthToken,
        clId,
        ctx,
        logger,
        orgId,
        roleId,
        sessionData,
        storefrontPermissions,
        storefrontPermissionsClient,
      })
    } catch (error) {
      logger.error({
        error,
        message: 'addUser-checkUserIsAllowedError',
      })
      throw error
    }

    if (clId && !userId) {
      userId = await getUser({
        clId,
        logger,
        masterdata,
        userId,
      })
    }

    return storefrontPermissionsClient
      .saveUser({
        clId,
        costId,
        email,
        id,
        name,
        orgId,
        roleId,
        userId,
      })
      .then((result: any) => {
        return result.data.saveUser
      })
      .catch((error: any) => {
        logger.error({
          error,
          message: 'addUser-error',
        })

        return { status: 'error', message: error }
      })
  },
}

export default Users

async function impersonateUser(
  storefrontPermissionsClient: any,
  userId: string | undefined,
  logger: any,
  accountName: string,
  storefrontPermissions: {
    costcenter: { value: string }
    userId: { value: string }
    organization: { value: string }
    storeUserEmail: { value: string }
  }
) {
  const result = await storefrontPermissionsClient
    .impersonateUser({ userId })
    .catch((error: any) => {
      logger.error({
        error,
        message: 'impersonateUser-impersonateUserError',
      })

      return { status: 'error', message: error }
    })

  const {
    costcenter,
    userId: userTargetId,
    organization,
    storeUserEmail,
  } = storefrontPermissions

  const metricParams: ImpersonateMetricParams = {
    account: accountName,
    target: {
      costCenterId: costcenter.value,
      organizationId: organization.value,
      email: storeUserEmail.value,
      id: userTargetId.value,
    },
    user: undefined, // no information about original user at this point
  }

  await sendImpersonateUserMetric(metricParams)

  return result
}
