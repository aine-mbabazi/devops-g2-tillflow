// Same forwarding rule as pos-client.js: the caller's own signed token is
// passed through, never re-minted by web.
export class PaymentsClient {
  constructor({ baseUrl, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async health() {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    return response.ok;
  }

  async getPayment({ authHeader, paymentId }) {
    const response = await this.fetchImpl(`${this.baseUrl}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { 'x-service-auth': authHeader },
    });
    return { status: response.status, body: await response.json() };
  }
}
