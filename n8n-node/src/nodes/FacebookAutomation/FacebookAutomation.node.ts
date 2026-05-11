import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionType,
  NodeOperationError,
} from 'n8n-workflow';

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
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main],
    credentials: [
      {
        name: 'facebookAutomationApi',
        required: true,
      },
    ],
    properties: [
      // Operation Selection
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
          {
            name: 'Auto Message',
            value: 'autoMessage',
            description: 'Send a message to a Facebook user',
            action: 'Send a message to a facebook user',
          },
        ],
        default: 'groupPostScraper',
      },

      // ---- Group Post Scraper Fields ----
      {
        displayName: 'Group URLs',
        name: 'groups',
        type: 'string',
        typeOptions: {
          rows: 4,
        },
        default: '',
        placeholder: 'https://www.facebook.com/groups/123456\nhttps://www.facebook.com/groups/789012',
        description: 'Facebook group URLs (one per line)',
        required: true,
        displayOptions: {
          show: {
            operation: ['groupPostScraper'],
          },
        },
      },
      {
        displayName: 'Last Scrape Timestamp',
        name: 'lastScrapeTimestamp',
        type: 'string',
        default: '',
        placeholder: '2024-01-01T00:00:00Z',
        description: 'Only scrape posts newer than this timestamp (ISO 8601)',
        displayOptions: {
          show: {
            operation: ['groupPostScraper'],
          },
        },
      },
      {
        displayName: 'Max Posts',
        name: 'maxPosts',
        type: 'number',
        default: 50,
        description: 'Maximum number of posts to scrape per group',
        displayOptions: {
          show: {
            operation: ['groupPostScraper'],
          },
        },
      },

      // ---- Group Member Scraper Fields ----
      {
        displayName: 'Group URLs',
        name: 'memberGroups',
        type: 'string',
        typeOptions: {
          rows: 4,
        },
        default: '',
        placeholder: 'https://www.facebook.com/groups/123456',
        description: 'Facebook group URLs (one per line)',
        required: true,
        displayOptions: {
          show: {
            operation: ['groupMemberScraper'],
          },
        },
      },
      {
        displayName: 'Max Members',
        name: 'maxMembers',
        type: 'number',
        default: 200,
        description: 'Maximum number of members to scrape per group',
        displayOptions: {
          show: {
            operation: ['groupMemberScraper'],
          },
        },
      },

      // ---- Auto Message Fields ----
      {
        displayName: 'Username',
        name: 'username',
        type: 'string',
        default: '',
        placeholder: 'John Doe',
        description: 'The Facebook user to message',
        required: true,
        displayOptions: {
          show: {
            operation: ['autoMessage'],
          },
        },
      },
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        typeOptions: {
          rows: 4,
        },
        default: '',
        placeholder: 'Hello! ...',
        description: 'The message to send',
        required: true,
        displayOptions: {
          show: {
            operation: ['autoMessage'],
          },
        },
      },

      // ---- Common Options ----
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
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
            default: 300000,
            description: 'Maximum time to wait for job completion (5 min default)',
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

    // Ensure session exists
    await this.ensureSession(apiUrl, apiKey, sessionName, cookiesJson, proxy, userAgent);

    const operation = this.getNodeParameter('operation', 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        let result: unknown;

        switch (operation) {
          case 'groupPostScraper':
            result = await this.executeGroupPostScraper(apiUrl, apiKey, sessionName, i);
            break;
          case 'groupMemberScraper':
            result = await this.executeGroupMemberScraper(apiUrl, apiKey, sessionName, i);
            break;
          case 'autoMessage':
            result = await this.executeAutoMessage(apiUrl, apiKey, sessionName, i);
            break;
          default:
            throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
        }

        if (Array.isArray(result)) {
          for (const item of result) {
            returnData.push({ json: item });
          }
        } else {
          returnData.push({ json: result as Record<string, unknown> });
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

  private async ensureSession(
    this: IExecuteFunctions,
    apiUrl: string,
    apiKey: string,
    sessionName: string,
    cookiesJson: string,
    proxy: string,
    userAgent: string,
  ): Promise<void> {
    // Check if session already exists
    try {
      const statusResponse = await this.helpers.request({
        method: 'GET',
        url: `${apiUrl}/api/session/status?sessionName=${encodeURIComponent(sessionName)}`,
        headers: { Authorization: `Bearer ${apiKey}` },
        json: true,
      });

      if (statusResponse.success && statusResponse.data?.isValid) {
        return; // Session exists and is valid
      }
    } catch {
      // Session doesn't exist, create it
    }

    // Import session
    if (!cookiesJson) {
      throw new NodeOperationError(
        this.getNode(),
        'No cookies provided. Please configure Facebook cookies in the credentials.',
      );
    }

    let cookies: unknown;
    try {
      cookies = JSON.parse(cookiesJson);
    } catch {
      throw new NodeOperationError(
        this.getNode(),
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

    await this.helpers.request({
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

  private async executeGroupPostScraper(
    this: IExecuteFunctions,
    apiUrl: string,
    apiKey: string,
    sessionName: string,
    itemIndex: number,
  ): Promise<unknown> {
    const groupsRaw = this.getNodeParameter('groups', itemIndex) as string;
    const groups = groupsRaw
      .split('\n')
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
    const lastScrapeTimestamp = this.getNodeParameter('lastScrapeTimestamp', itemIndex, '') as string;
    const maxPosts = this.getNodeParameter('maxPosts', itemIndex, 50) as number;
    const options = this.getNodeParameter('options', itemIndex, {}) as Record<string, unknown>;

    const response = await this.helpers.request({
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
      },
      json: true,
    });

    if (options.waitForCompletion !== false) {
      return this.waitForJob(apiUrl, apiKey, response.jobId, options);
    }

    return response;
  }

  private async executeGroupMemberScraper(
    this: IExecuteFunctions,
    apiUrl: string,
    apiKey: string,
    sessionName: string,
    itemIndex: number,
  ): Promise<unknown> {
    const groupsRaw = this.getNodeParameter('memberGroups', itemIndex) as string;
    const groups = groupsRaw
      .split('\n')
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
    const maxMembers = this.getNodeParameter('maxMembers', itemIndex, 200) as number;
    const options = this.getNodeParameter('options', itemIndex, {}) as Record<string, unknown>;

    const response = await this.helpers.request({
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
      return this.waitForJob(apiUrl, apiKey, response.jobId, options);
    }

    return response;
  }

  private async executeAutoMessage(
    this: IExecuteFunctions,
    apiUrl: string,
    apiKey: string,
    sessionName: string,
    itemIndex: number,
  ): Promise<unknown> {
    const username = this.getNodeParameter('username', itemIndex) as string;
    const message = this.getNodeParameter('message', itemIndex) as string;
    const options = this.getNodeParameter('options', itemIndex, {}) as Record<string, unknown>;

    const response = await this.helpers.request({
      method: 'POST',
      url: `${apiUrl}/api/message/send`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        sessionName,
        username,
        message,
      },
      json: true,
    });

    if (options.waitForCompletion !== false) {
      return this.waitForJob(apiUrl, apiKey, response.jobId, options);
    }

    return response;
  }

  private async waitForJob(
    this: IExecuteFunctions,
    apiUrl: string,
    apiKey: string,
    jobId: string,
    options: Record<string, unknown>,
  ): Promise<unknown> {
    const pollInterval = (options.pollInterval as number) || 5000;
    const maxWaitTime = (options.maxWaitTime as number) || 300000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const statusResponse = await this.helpers.request({
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
          this.getNode(),
          `Job failed: ${jobData.error || 'Unknown error'}`,
        );
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new NodeOperationError(
      this.getNode(),
      `Job ${jobId} timed out after ${maxWaitTime}ms`,
    );
  }
}
