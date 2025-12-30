const { PassThrough } = require('stream');

// Mock modules used by transcriptionWorker
jest.mock('../src/models/Meeting');
jest.mock('../src/services/storageService');
jest.mock('../src/services/whisperxService');
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Meeting = require('../src/models/Meeting');
const storageService = require('../src/services/storageService');
const whisperx = require('../src/services/whisperxService');

const { processTranscription } = require('../src/workers/transcriptionWorker');

describe('processTranscription', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('stores dueDateRaw when date is non-ISO string', async () => {
    // Mock meeting instance
    const fakeMeeting = {
      _id: 'm1',
      originalFile: { filename: 'file.mp3', originalName: 'file.mp3' },
      processingLogs: [],
      save: jest.fn().mockResolvedValue(true),
      updateStatus: jest.fn().mockResolvedValue(true),
      incrementRetry: jest.fn().mockResolvedValue(true)
    };

    Meeting.findById.mockResolvedValue(fakeMeeting);

    // Mock retrieveFile to return a readable stream
    storageService.retrieveFile.mockImplementation(() => {
      const s = new PassThrough();
      process.nextTick(() => s.end());
      return s;
    });

    // Mock transcribeAudio to return action_items with Indonesian date
    whisperx.transcribeAudio.mockResolvedValue({
      language: 'id',
      transcript: 'hello',
      segments: [],
      speakers: [],
      metadata: { duration: 5 },
      action_items: [ { title: 'Task 1', dueDate: '14 Oktober' } ],
    });

    const fakeJob = { data: { meetingId: 'm1' }, id: 'job1', updateProgress: jest.fn() };

    const res = await processTranscription(fakeJob);

    // After processing, meeting.actionItems should exist and contain dueDateRaw
    expect(fakeMeeting.save).toHaveBeenCalled();
    expect(fakeMeeting.actionItems).toBeDefined();
    expect(fakeMeeting.actionItems.length).toBeGreaterThan(0);
    const ai = fakeMeeting.actionItems[0];
    // dueDate may be parsed to a Date (chrono may infer year) or left null; accept both
    if (ai.dueDate) {
      expect(ai.dueDate).toBeInstanceOf(Date);
    } else {
      expect(ai.dueDate).toBeNull();
    }
    expect(ai.dueDateRaw).toBe('14 Oktober');
    expect(res.success).toBe(true);
  });
});
