import { runMigrations } from '../src/database/run-migrations';

const accessMock = jest.fn();
const readdirMock = jest.fn();

jest.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => accessMock(...args),
  readdir: (...args: unknown[]) => readdirMock(...args),
  readFile: jest.fn(),
}));

type MockClient = {
  connect: jest.Mock<Promise<void>, []>;
  query: jest.Mock<Promise<{ rows: unknown[] }>, [string, unknown[]?]>;
  end: jest.Mock<Promise<void>, []>;
};

const clientFactory = jest.fn<MockClient, [{ connectionString: string }]>();

jest.mock('pg', () => ({
  Client: function MockClient(options: { connectionString: string }) {
    return clientFactory(options);
  },
}));

function createClient(config: {
  connectError?: Error & { code?: string };
  queryResults?: Array<{ rows: unknown[] }>;
}) {
  const queryResults = config.queryResults ?? [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];
  return {
    connect: config.connectError
      ? jest.fn().mockRejectedValue(config.connectError)
      : jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { rows: [] }),
    end: jest.fn().mockResolvedValue(undefined),
  } satisfies MockClient;
}

describe('runMigrations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accessMock.mockResolvedValue(undefined);
    readdirMock.mockResolvedValue([]);
  });

  it('retries with a fresh client after a retryable connection failure', async () => {
    const firstClient = createClient({ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const secondClient = createClient({});
    clientFactory
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);

    const onRetry = jest.fn();

    await expect(runMigrations('postgres://example', { connectRetries: 2, retryDelayMs: 0, onRetry })).resolves.toEqual({
      appliedCount: 0,
      completed: true,
    });

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, { connectionString: 'postgres://example' });
    expect(clientFactory).toHaveBeenNthCalledWith(2, { connectionString: 'postgres://example' });
    expect(firstClient.connect).toHaveBeenCalledTimes(1);
    expect(firstClient.end).toHaveBeenCalledTimes(1);
    expect(secondClient.connect).toHaveBeenCalledTimes(1);
    expect(secondClient.query).toHaveBeenCalledTimes(4);
    expect(secondClient.end).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 2, expect.objectContaining({ code: 'ECONNREFUSED' }));
  });

  it('fails immediately on a non-retryable connection error', async () => {
    const client = createClient({ connectError: Object.assign(new Error('auth failed'), { code: '28P01' }) });
    clientFactory.mockReturnValueOnce(client);

    await expect(runMigrations('postgres://example', { connectRetries: 3, retryDelayMs: 0 })).rejects.toMatchObject({
      code: '28P01',
    });

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retryable connection attempts', async () => {
    const firstClient = createClient({ connectError: Object.assign(new Error('refused once'), { code: 'ECONNREFUSED' }) });
    const secondClient = createClient({ connectError: Object.assign(new Error('refused twice'), { code: 'ECONNREFUSED' }) });
    clientFactory
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);

    await expect(runMigrations('postgres://example', { connectRetries: 2, retryDelayMs: 0 })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
      message: 'refused twice',
    });

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(firstClient.end).toHaveBeenCalledTimes(1);
    expect(secondClient.end).toHaveBeenCalledTimes(1);
  });
});
