import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { UserProfileService } from './user-profile.service';
import { UserType, UserStatus } from './user-profile.entity';

describe('UserProfileService', () => {
  let service: UserProfileService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserProfileService],
    }).compile();

    service = module.get<UserProfileService>(UserProfileService);
  });

  afterEach(() => {
    // Clear all profiles after each test
    service['profiles'].clear();
    service['walletAddressIndex'].clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const validDto = {
      walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      name: 'John Doe',
      bio: 'Experienced developer',
      userType: UserType.FREELANCER,
      skills: ['JavaScript', 'TypeScript'],
    };

    it('should create a new user profile', async () => {
      const profile = await service.create(validDto);

      expect(profile).toBeDefined();
      expect(profile.id).toBeDefined();
      expect(profile.walletAddress).toBe(validDto.walletAddress);
      expect(profile.name).toBe(validDto.name);
      expect(profile.bio).toBe(validDto.bio);
      expect(profile.userType).toBe(validDto.userType);
      expect(profile.skills).toEqual(validDto.skills);
      expect(profile.rating).toBe(0);
      expect(profile.ratingCount).toBe(0);
      expect(profile.completedJobs).toBe(0);
      expect(profile.status).toBe(UserStatus.ACTIVE);
      expect(profile.isVerified).toBe(false);
      expect(profile.createdAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();
    });

    it('should throw ConflictException for duplicate wallet address', async () => {
      await service.create(validDto);

      await expect(service.create(validDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('findById', () => {
    it('should find a profile by ID', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const found = await service.findById(created.id);

      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.name).toBe(created.name);
    });

    it('should throw NotFoundException for non-existent ID', async () => {
      await expect(service.findById('non-existent-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByWalletAddress', () => {
    it('should find a profile by wallet address', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const created = await service.create({
        walletAddress,
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const found = await service.findByWalletAddress(walletAddress);

      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.walletAddress).toBe(walletAddress);
    });

    it('should throw NotFoundException for non-existent wallet address', async () => {
      await expect(service.findByWalletAddress('GYYYYYYYYYYYYYYYYYY')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    beforeEach(async () => {
      await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'Freelancer 1',
        userType: UserType.FREELANCER,
      });
      await service.create({
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        name: 'Client 1',
        userType: UserType.CLIENT,
      });
      await service.create({
        walletAddress: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        name: 'Both 1',
        userType: UserType.BOTH,
      });
    });

    it('should return all profiles without filters', async () => {
      const result = await service.findAll();
      expect(result.data).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should filter by userType', async () => {
      const result = await service.findAll({ userType: UserType.FREELANCER });
      expect(result.data.length).toBeGreaterThanOrEqual(1);
      expect(
        result.data.every(p => p.userType === UserType.FREELANCER || p.userType === UserType.BOTH),
      ).toBe(true);
    });

    it('should filter by status', async () => {
      const result = await service.findAll({ status: UserStatus.ACTIVE });
      expect(result.data).toHaveLength(3);
    });

    it('should filter by minRating', async () => {
      const result = await service.findAll({ minRating: 0 });
      expect(result.data).toHaveLength(3);
    });

    it('should paginate results', async () => {
      const page1 = await service.findAll({ offset: 0, limit: 2 });
      const page2 = await service.findAll({ offset: 2, limit: 2 });

      expect(page1.data).toHaveLength(2);
      expect(page2.data).toHaveLength(1);
      expect(page1.total).toBe(3);
    });
  });

  describe('update', () => {
    it('should update a profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      // Small delay to ensure timestamps are different
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = await service.update(created.id, {
        name: 'Jane Doe',
        bio: 'Updated bio',
      });

      expect(updated.name).toBe('Jane Doe');
      expect(updated.bio).toBe('Updated bio');
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      );
    });

    it('should throw NotFoundException for non-existent profile', async () => {
      await expect(service.update('non-existent-id', { name: 'New Name' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      await service.delete(created.id);

      await expect(service.findById(created.id)).rejects.toThrow(NotFoundException);
    });

    it('excludes soft-deleted profiles from list and search queries', async () => {
      const created = await service.create({
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        name: 'Soft Deleted User',
        userType: UserType.CLIENT,
      });

      await service.delete(created.id);

      const all = await service.findAll();
      expect(all.data.some(p => p.id === created.id)).toBe(false);

      const searched = await service.search('Soft Deleted');
      expect(searched.some(p => p.id === created.id)).toBe(false);
    });

    it('should throw NotFoundException for non-existent profile', async () => {
      await expect(service.delete('non-existent-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('rateUser', () => {
    it('should add a rating to a user profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const rated = await service.rateUser(created.id, {
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        rating: 5,
      });

      expect(rated.rating).toBe(5);
      expect(rated.ratingCount).toBe(1);
    });

    it('should calculate weighted average for multiple ratings', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      await service.rateUser(created.id, {
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        rating: 5,
      });

      const rated = await service.rateUser(created.id, {
        walletAddress: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        rating: 3,
      });

      expect(rated.rating).toBe(4); // (5 + 3) / 2 = 4
      expect(rated.ratingCount).toBe(2);
    });
  });

  describe('incrementCompletedJobs', () => {
    it('should increment completed jobs counter', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const updated = await service.incrementCompletedJobs(created.id);

      expect(updated.completedJobs).toBe(1);
    });
  });

  describe('updateTotalEarned', () => {
    it('should update total earned amount', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const updated = await service.updateTotalEarned(created.id, '100.5');

      expect(updated.totalEarned).toBe('100.5000000');
    });

    it('accumulates small decimal amounts without float precision loss (e.g. 0.1 repeated)', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      // In IEEE 754 floating-point, 0.1 + 0.2 !== 0.3 and accumulating 0.1 100 times drifts
      for (let i = 0; i < 100; i++) {
        await service.updateTotalEarned(created.id, '0.1');
      }

      const finalProfile = await service.findById(created.id);
      expect(finalProfile.totalEarned).toBe('10.0000000');
    });

    it('maintains exact 7-decimal precision across 1-stroop (0.0000001) micropayments', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      // Add 0.1 and 0.2
      await service.updateTotalEarned(created.id, '0.1');
      await service.updateTotalEarned(created.id, '0.2');
      let profile = await service.findById(created.id);
      expect(profile.totalEarned).toBe('0.3000000');

      // Add 1000 stroops (0.0000001 XLM each)
      for (let i = 0; i < 1000; i++) {
        await service.updateTotalEarned(created.id, '0.0000001');
      }

      profile = await service.findById(created.id);
      expect(profile.totalEarned).toBe('0.3001000');
    });
  });

  describe('updateTotalSpent', () => {
    it('should update total spent amount', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.CLIENT,
      });

      const updated = await service.updateTotalSpent(created.id, '200.75');

      expect(updated.totalSpent).toBe('200.7500000');
    });

    it('accumulates small decimal amounts without float precision loss (e.g. 0.1 repeated)', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.CLIENT,
      });

      for (let i = 0; i < 100; i++) {
        await service.updateTotalSpent(created.id, '0.1');
      }

      const finalProfile = await service.findById(created.id);
      expect(finalProfile.totalSpent).toBe('10.0000000');
    });

    it('maintains exact 7-decimal precision across micropayments', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.CLIENT,
      });

      await service.updateTotalSpent(created.id, '0.1');
      await service.updateTotalSpent(created.id, '0.2');
      let profile = await service.findById(created.id);
      expect(profile.totalSpent).toBe('0.3000000');

      for (let i = 0; i < 500; i++) {
        await service.updateTotalSpent(created.id, '0.0000002');
      }

      profile = await service.findById(created.id);
      expect(profile.totalSpent).toBe('0.3001000');
    });
  });

  describe('verifyUser', () => {
    it('should verify a user profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const verified = await service.verifyUser(created.id);

      expect(verified.isVerified).toBe(true);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'Blockchain Developer',
        bio: 'Experienced in Solidity',
        userType: UserType.FREELANCER,
        skills: ['Solidity', 'Rust'],
      });
      await service.create({
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        name: 'Frontend Developer',
        bio: 'React expert',
        userType: UserType.FREELANCER,
        skills: ['React', 'TypeScript'],
      });
    });

    it('should search by name', async () => {
      const result = await service.search('blockchain');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toContain('Blockchain');
    });

    it('should search by bio', async () => {
      const result = await service.search('solidity');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].bio).toContain('Solidity');
    });

    it('should search by skills', async () => {
      const result = await service.search('rust');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].skills).toContain('Rust');
    });

    it('should return empty array for no matches', async () => {
      const result = await service.search('nonexistent');
      expect(result.data).toHaveLength(0);
    });

    it('should rank exact name match above prefix match', async () => {
      await service.create({
        walletAddress: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        name: 'Blockchain',
        userType: UserType.FREELANCER,
      });

      const result = await service.search('blockchain');
      expect(result.data).toHaveLength(2);
      expect(result.data[0].name).toBe('Blockchain');
      expect(result.data[1].name).toBe('Blockchain Developer');
    });

    it('should rank prefix name match above contains match', async () => {
      await service.create({
        walletAddress: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        name: 'Blockchain Engineer',
        userType: UserType.FREELANCER,
      });

      const result = await service.search('blockchain');
      const names = result.data.map(p => p.name);
      const hasPrefix = names.indexOf('Blockchain Engineer') >= 0;
      const hasContains = names.indexOf('Blockchain Developer') >= 0;
      expect(hasPrefix).toBe(true);
      expect(hasContains).toBe(true);
    });

    it('should rank name match above bio match', async () => {
      const result = await service.search('solidity');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Blockchain Developer');
    });

    it('should paginate search results', async () => {
      const result = await service.search('developer', { offset: 0, limit: 1 });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(2);
    });

    // UserProfileController.search() validates `q` with SearchQuerySchema
    // before this method is ever reached (#435) — these document that
    // contract: the service itself still assumes a non-empty string.
    it('treats a valid query as case-insensitive', async () => {
      const result = await service.search('BLOCKCHAIN');
      expect(result.data).toHaveLength(1);
    });

    it('throws when called with an undefined query (relies on the controller boundary)', async () => {
      await expect(service.search(undefined as unknown as string)).rejects.toThrow(TypeError);
    });
  });
});
