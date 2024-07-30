import type { InstanceOptions, IOContext } from '@vtex/api'
import { JanusClient } from '@vtex/api'

const SELLERS_PATH = '/api/seller-register/pvt/sellers'

export interface Seller {
  id: string
  name: string
  email: string
}

export default class SellersClient extends JanusClient {
  constructor(context: IOContext, options?: InstanceOptions) {
    super(context, {
      ...options,
      headers: {
        VtexIdClientAutCookie: context.authToken,
      },
    })
  }

  public async getSellers(paging?: {
    from: number
    to: number
  }): Promise<{ items: Seller[] }> {
    return this.http.get(SELLERS_PATH, {
      metric: 'sellers-get',
      params: {
        from: paging?.from ?? 0,
        to: paging?.to ?? 100,
      },
    })
  }
}
