import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

async function ensureSession(
  ctx: IExecuteFunctions,
  apiUrl: string,
  apiKey: string,
  sessionName: string,
  cookiesJson: string,
  proxy: string,
  userAgent: string,
): Promise<void> {
  try {
    const statusResponse = await ctx.helpers.request({
      method: 'GET',
      url: `${apiUrl}/api/session/status?sessionName=${encodeURIComponent(sessionName)}`,
      headers: { Authorization: `Bearer ${apiKey}` },
      json: true,
    });

    if (statusResponse.success && statusResponse.data?.isValid) {
      return;
    }
  } catch {
    // Session doesn't exist, create it
  }

  if (!cookiesJson) {
    throw new NodeOperationError(
      ctx.getNode(),
      'No cookies provided. Please configure Facebook cookies in the credentials.',
    );
  }

  let cookies: unknown;
  try {
    cookies = JSON.parse(cookiesJson);
  } catch {
    throw new NodeOperationError(
      ctx.getNode(),
      'Invalid cookie JSON format. Please check your cookies configuration.',
    );
  }

  const importBody: Record<string, unknown> = {
    sessionName,
    cookies,
    format: 'json',
  };

  if (proxy) {
    importBody.proxy = { server: proxy };
  }
  if (userAgent) {
    importBody.userAgent = userAgent;
  }

  await ctx.helpers.request({
    method: 'POST',
    url: `${apiUrl}/api/session/import`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: importBody,
    json: true,
  });
}

async function waitForJob(
  ctx: IExecuteFunctions,
  apiUrl: string,
  apiKey: string,
  jobId: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  const pollInterval = (options.pollInterval as number) || 5000;
  const maxWaitTime = (options.maxWaitTime as number) || 600000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const statusResponse = await ctx.helpers.request({
      method: 'GET',
      url: `${apiUrl}/api/job/${jobId}`,
      headers: { Authorization: `Bearer ${apiKey}` },
      json: true,
    });

    const jobData = statusResponse.data;

    if (jobData.status === 'completed') {
      return jobData.result;
    }

    if (jobData.status === 'failed') {
      throw new NodeOperationError(
        ctx.getNode(),
        `Job failed: ${jobData.error || 'Unknown error'}`,
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new NodeOperationError(
    ctx.getNode(),
    `Job ${jobId} timed out after ${maxWaitTime}ms`,
  );
}

async function executeGroupPostScraper(
  ctx: IExecuteFunctions,
  apiUrl: string,
  apiKey: string,
  sessionName: string,
  itemIndex: number,
): Promise<unknown> {
  const groupsRaw = ctx.getNodeParameter('groups', itemIndex);
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.map((g) => String(g).trim()).filter((g) => g.length > 0)
    : String(groupsRaw)
        .split('\n')
        .map((g) => g.trim())
        .filter((g) => g.length > 0);
  const lastScrapeTimestamp = ctx.getNodeParameter('lastScrapeTimestamp', itemIndex, '') as string;
  const maxPosts = ctx.getNodeParameter('maxPosts', itemIndex, 50) as number;
  const options = ctx.getNodeParameter('options', itemIndex, {}) as Record<string, unknown>;

  const response = await ctx.helpers.request({
    method: 'POST',
    url: `${apiUrl}/api/scrape/posts`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      sessionName,
      groups,
      lastScrapeTimestamp: lastScrapeTimestamp || undefined,
      maxPosts,
      scrollTimeout: options.scrollTimeout,
      groupDelay: options.groupDelay,
    },
    json: true,
  });

  if (options.waitForCompletion !== false) {
    // Auto-scale maxWaitTime based on number of groups if not explicitly set
    const autoOptions = { ...options };
    if (!options.maxWaitTime) {
      const groupDelay = (options.groupDelay as number) || 5000;
      const estimatedTime = groups.length * (groupDelay + 10000); // delay + ~10s per group for scraping
      autoOptions.maxWaitTime = Math.max(600000, estimatedTime);
    }
    return waitForJob(ctx, apiUrl, apiKey, response.jobId, autoOptions);
  }

  return response;
}

async function executeGroupMemberScraper(
  ctx: IExecuteFunctions,
  apiUrl: string,
  apiKey: string,
  sessionName: string,
  itemIndex: number,
): Promise<unknown> {
  const groupsRaw = ctx.getNodeParameter('memberGroups', itemIndex);
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.map((g) => String(g).trim()).filter((g) => g.length > 0)
    : String(groupsRaw)
        .split('\n')
        .map((g) => g.trim())
        .filter((g) => g.length > 0);
  const maxMembers = ctx.getNodeParameter('maxMembers', itemIndex, 200) as number;
  const options = ctx.getNodeParameter('options', itemIndex, {}) as Record<string, unknown>;

  const response = await ctx.helpers.request({
    method: 'POST',
    url: `${apiUrl}/api/scrape/members`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      sessionName,
      groups,
      maxMembers,
      scrollTimeout: options.scrollTimeout,
    },
    json: true,
  });

  if (options.waitForCompletion !== false) {
    return waitForJob(ctx, apiUrl, apiKey, response.jobId, options);
  }

  return response;
}

export class FacebookAutomation implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Facebook Automation',
    name: 'facebookAutomation',
    icon: 'file:facebook.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Automate Facebook using browser automation (cookie-based auth)',
    defaults: {
      name: 'Facebook Automation',
    },
    inputs: ['main'] as any,
    outputs: ['main'] as any,
    credentials: [
      {
        name: 'facebookAutomationApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Group Post Scraper',
            value: 'groupPostScraper',
            description: 'Scrape posts from Facebook groups',
            action: 'Scrape posts from facebook groups',
          },
          {
            name: 'Group Member Scraper',
            value: 'groupMemberScraper',
            description: 'Scrape members from Facebook groups',
            action: 'Scrape members from facebook groups',
          },
        ],
        default: 'groupPostScraper',
      },
      {
        displayName: 'Group URLs',
        name: 'groups',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        placeholder: 'https://www.facebook.com/groups/123456\nhttps://www.facebook.com/groups/789012',
        description: 'Facebook group URLs (one per line)',
        required: true,
        displayOptions: { show: { operation: ['groupPostScraper'] } },
      },
      {
        displayName: 'Last Scrape Timestamp',
        name: 'lastScrapeTimestamp',
        type: 'string',
        default: '',
        placeholder: '2024-01-01T00:00:00Z',
        description: 'Only scrape posts newer than this timestamp (ISO 8601)',
        displayOptions: { show: { operation: ['groupPostScraper'] } },
      },
      {
        displayName: 'Max Posts Per Group',
        name: 'maxPosts',
        type: 'number',
        default: 50,
        description: 'Maximum number of posts to scrape per group (each group is scraped individually up to this limit)',
        displayOptions: { show: { operation: ['groupPostScraper'] } },
      },
      {
        displayName: 'Group URLs',
        name: 'memberGroups',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        placeholder: 'https://www.facebook.com/groups/123456',
        description: 'Facebook group URLs (one per line)',
        required: true,
        displayOptions: { show: { operation: ['groupMemberScraper'] } },
      },
      {
        displayName: 'Max Members',
        name: 'maxMembers',
        type: 'number',
        default: 200,
        description: 'Maximum number of members to scrape per group',
        displayOptions: { show: { operation: ['groupMemberScraper'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Group Delay (ms)',
            name: 'groupDelay',
            type: 'number',
            default: 5000,
            description: 'Delay between scraping each group to avoid rate-limiting (in milliseconds)',
          },
          {
            displayName: 'Scroll Timeout (ms)',
            name: 'scrollTimeout',
            type: 'number',
            default: 60000,
            description: 'Maximum time to scroll for content',
          },
          {
            displayName: 'Wait For Completion',
            name: 'waitForCompletion',
            type: 'boolean',
            default: true,
            description: 'Whether to wait for the job to complete before returning',
          },
          {
            displayName: 'Poll Interval (ms)',
            name: 'pollInterval',
            type: 'number',
            default: 5000,
            description: 'How often to check job status when waiting',
          },
          {
            displayName: 'Max Wait Time (ms)',
            name: 'maxWaitTime',
            type: 'number',
            default: 600000,
            description: 'Maximum time to wait for job completion (10 min default, increase for many groups)',
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials('facebookAutomationApi');

    const apiUrl = (credentials.apiUrl as string).replace(/\/$/, '');
    const apiKey = credentials.apiKey as string;
    const sessionName = credentials.sessionName as string;
    const cookiesJson = credentials.cookiesJson as string;
    const proxy = credentials.proxy as string;
    const userAgent = credentials.userAgent as string;

    await ensureSession(this, apiUrl, apiKey, sessionName, cookiesJson, proxy, userAgent);

    const operation = this.getNodeParameter('operation', 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        let result: unknown;

        switch (operation) {
          case 'groupPostScraper':
            result = await executeGroupPostScraper(this, apiUrl, apiKey, sessionName, i);
            break;
          case 'groupMemberScraper':
            result = await executeGroupMemberScraper(this, apiUrl, apiKey, sessionName, i);
            break;
          default:
            throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
        }

        if (Array.isArray(result)) {
          for (const item of result) {
            returnData.push({ json: item as IDataObject });
          }
        } else {
          returnData.push({ json: result as IDataObject });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: error instanceof Error ? error.message : 'Unknown error',
            },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
