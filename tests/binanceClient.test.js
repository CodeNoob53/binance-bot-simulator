import assert from 'assert';
import client from '../src/api/binanceClient.js';

export async function testRequestThrowsOn400() {
  const originalGet = client.axios.get;
  client.axios.get = async () => ({
    status: 400,
    data: { code: -1102, msg: 'Bad request' },
    headers: {}
  });

  try {
    await assert.rejects(
      client.request('/api/test'),
      /Bad request/
    );
  } finally {
    client.axios.get = originalGet;
  }
}
